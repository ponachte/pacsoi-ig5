import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../config.js";
import { delay, errorDetails, expectResponse, fetchWithTimeout } from "../http.js";
import { readRun } from "../report.js";
import {
  BOOTSTRAP,
  POD_PREFIX,
  REQUEST_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  SLICE_NAME,
  STARTUP_TIMEOUT_MS,
} from "../scenario.js";
import { binomialConfidenceInterval, bootstrapRecords, seedForLabel } from "../statistics.js";
import { runExperiment } from "./runner.js";
import { generateExperimentReport } from "../experiment-report.js";

const STARTUP_PERFORMANCE_FIELDS = [
  "initialCorrectMs", "benchmarkWaitMs", "observedServiceUptimeMs", "peakRssMiB", "peakHeapMiB", "cpuSeconds",
];
const WORKLOAD_FIELDS = ["observationsAdded", "cumulativeObservations", "triplesAdded", "cumulativeTriples"];
const LATENCY_FIELDS = ["pushMs", "propagationMs", "endToEndMs", "endToEndLowerBoundMs", "distributionRequestMs"];
const YEAR_FIELDS = ["yearWallMs", "sumEndToEndMs", "sumPushMs", "sumPropagationMs", "maxEndToEndMs"];
const RESOURCE_FIELDS = ["peakRssMiB", "peakHeapMiB", "cpuSeconds", "eventLoopDelayMs"];

// validateConfig guarantees local http URLs with an explicit port.
function localAddress(serverUrl) {
  const url = new URL(serverUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return { host: hostname === "localhost" ? "0.0.0.0" : hostname, port: Number(url.port) };
}

export function startProcess(command, args, options, logFile) {
  const output = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.once("close", () => output.end());
  child.startedAt = new Date().toISOString();
  const observeLog = (chunk) => {
    child.oomScanBuffer = `${child.oomScanBuffer ?? ""}${chunk.toString("utf8")}`.slice(-8192);
    if (!child.oomLogObservedAt &&
        /FATAL ERROR:[^\r\n]*(?:heap out of memory|heap limit|allocation failed)|FATAL ERROR:[\s\S]{0,256}JavaScript heap out of memory/i.test(child.oomScanBuffer)) {
      child.oomLogObservedAt = new Date().toISOString();
      child.oomLogEvidence = child.oomScanBuffer.match(/FATAL ERROR:[\s\S]{0,256}/i)?.[0].trim();
    }
  };
  child.stdout.on("data", observeLog);
  child.stderr.on("data", observeLog);
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    child.exitedAt = new Date().toISOString();
    // stopProcess marks a deliberate stop before signalling, so anything else
    // (including a SIGKILL from stopProcess's own timeout) is not a crash.
    child.unexpectedExit = !child.expectedStop;
    resolve({ code, signal, exitedAt: child.exitedAt });
  }));
  child.logFinished = new Promise((resolve) => output.once("finish", resolve));
  return child;
}

export function watchProcessExit(child, label, logFile, controller) {
  return child.exited.then(({ code, signal }) => {
    if (child.expectedStop) return new Promise(() => {});
    const reason = `${label} exited unexpectedly with ${signal ? `signal ${signal}` : `code ${code}`}`;
    const error = new Error(`${reason}; see ${logFile}`);
    error.processLabel = label;
    error.processExitCode = code;
    error.processSignal = signal;
    error.processExitedAt = child.exitedAt;
    if (!controller.signal.aborted) controller.abort(error);
    return error;
  });
}

function lifecycleFetch(controller) {
  return async (url, options = {}) => {
    const signals = [options.signal, controller.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      return await fetch(url, { ...options, signal });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
  };
}

export async function stopProcess(child, timeoutMs) {
  if (!child) return;
  child.expectedStop = true;
  if (child.exitCode !== null || child.signalCode !== null) {
    await child.logFinished;
    return;
  }
  child.kill("SIGTERM");
  const timedOut = await Promise.race([child.exited.then(() => false), delay(timeoutMs).then(() => true)]);
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await child.logFinished;
}

async function waitForHealth(url, child, label, fetchImpl = fetch) {
  const started = performance.now();
  let latest;
  while (performance.now() - started < STARTUP_TIMEOUT_MS) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `${label} exited during startup with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}`,
      );
    }
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {},
        Math.min(REQUEST_TIMEOUT_MS, Math.max(1, STARTUP_TIMEOUT_MS - (performance.now() - started))),
        `Reach ${label}`,
      );
      if (response.ok) return response.json();
      latest = `HTTP ${response.status}`;
    } catch (error) {
      if (error.processLabel) throw error;
      latest = error.message;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${latest ?? "no response"}`);
}

async function buildService(logFile) {
  const child = startProcess("npm", ["--prefix", "service", "run", "build"], { cwd: projectRoot }, logFile);
  const code = await new Promise((resolve) => child.once("exit", resolve));
  await child.logFinished;
  if (code !== 0) throw new Error(`Service build failed with code ${code}; see ${logFile}`);
}

export function heapArguments(maxOldSpaceMiB) {
  return maxOldSpaceMiB ? [`--max-old-space-size=${maxOldSpaceMiB}`] : [];
}

// Confirms both processes run the configured scale and engine before the
// benchmark starts.
async function verifyProcesses(config, fetchImpl) {
  const health = async (url, operation) => expectResponse(
    await fetchWithTimeout(fetchImpl, url, {}, REQUEST_TIMEOUT_MS, operation), 200, operation,
  );
  const mock = await health(`${config.mock.serverUrl}/health`, "Reach mock pod server");
  const service = await health(`${config.service.serverUrl}/health`, "Reach service");
  const { podCount, writeConcurrency } = config.experiment;
  if (mock.podCount !== podCount || mock.writeConcurrency !== writeConcurrency || mock.day !== 0) {
    throw new Error(
      `Mock reports podCount=${mock.podCount}, writeConcurrency=${mock.writeConcurrency}, day=${mock.day}; ` +
      `expected podCount=${podCount}, writeConcurrency=${writeConcurrency}, day=0`,
    );
  }
  if (
    service.podCount !== podCount
    || service.serviceVersion !== config.service.version
    || service.distributionStrategy !== config.service.distribution
  ) {
    throw new Error(
      `Service reports podCount=${service.podCount}, version=${service.serviceVersion}, ` +
      `distribution=${service.distributionStrategy}; expected podCount=${podCount}, ` +
      `version=${config.service.version}, distribution=${config.service.distribution}`,
    );
  }
}

// One repetition: a fresh mock and service, the benchmark, and a clean stop.
async function runManagedTrial(config, repetition, directory) {
  const mockAddress = localAddress(config.mock.serverUrl);
  const serviceAddress = localAddress(config.service.serverUrl);
  const stem = `repetition-${String(repetition).padStart(3, "0")}`;
  const mockLog = path.join(directory, `${stem}-mock.log`);
  const serviceLog = path.join(directory, `${stem}-service.log`);
  const output = path.join(directory, `${stem}.ndjson`);
  let mock;
  let service;
  let runError;
  const lifecycle = new AbortController();
  const managedFetch = lifecycleFetch(lifecycle);
  const exitFailures = [];
  try {
    mock = startProcess(process.execPath, [
      "mock/pod-server.js", `--host=${mockAddress.host}`, `--port=${mockAddress.port}`,
      `--public-url=${config.mock.serverUrl}`, `--pod-count=${config.experiment.podCount}`,
      `--write-concurrency=${config.experiment.writeConcurrency}`,
    ], { cwd: projectRoot }, mockLog);
    exitFailures.push(watchProcessExit(mock, "mock server", mockLog, lifecycle));
    await waitForHealth(`${config.mock.serverUrl}/health`, mock, "mock server", managedFetch);

    service = startProcess(process.execPath, [
      ...heapArguments(config.experiment.serviceMaxOldSpaceMiB),
      "service/dist/index.js",
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        POD_SERVER_URL: config.mock.serverUrl,
        POD_PREFIX,
        POD_COUNT: String(config.experiment.podCount),
        SLICE_NAME,
        SERVICE_VERSION: config.service.version,
        DISTRIBUTION: config.service.distribution,
        PORT: String(serviceAddress.port),
      },
    }, serviceLog);
    exitFailures.push(watchProcessExit(service, "service", serviceLog, lifecycle));
    await waitForHealth(`${config.service.serverUrl}/health`, service, "service", managedFetch);
    await verifyProcesses(config, managedFetch);

    const run = runExperiment(config, managedFetch, { output, repetition, diagnosticFetchImpl: fetch });
    try {
      await Promise.race([run, ...exitFailures.map((exit) => exit.then((error) => { throw error; }))]);
    } catch (error) {
      if (!lifecycle.signal.aborted) lifecycle.abort(error);
      // Let the run write its failure record; its error carries that record.
      await run;
      throw error;
    }
    return { repetition, output, log: serviceLog, mockLog };
  } catch (error) {
    runError = error;
    error.runOutput ??= output;
    error.runLog = serviceLog;
    error.mockLog = mockLog;
    throw error;
  } finally {
    await stopProcess(service, SHUTDOWN_TIMEOUT_MS);
    await stopProcess(mock, SHUTDOWN_TIMEOUT_MS);
    if (runError) {
      runError.processes = {
        service: processSnapshot(service, "service", serviceLog),
        mock: processSnapshot(mock, "mock", mockLog),
      };
    }
  }
}

function processSnapshot(child, name, log) {
  if (!child) return { process: name, started: false, log };
  return {
    process: name,
    started: true,
    log,
    pid: child.pid,
    startedAt: child.startedAt,
    exitedAt: child.exitedAt,
    exitCode: child.exitCode,
    signal: child.signalCode,
    unexpectedExit: Boolean(child.unexpectedExit),
    oomLogObservedAt: child.oomLogObservedAt,
    oomLogEvidence: child.oomLogEvidence,
  };
}

export function classifyFailureLog(logText = "") {
  const outOfMemory = /heap out of memory|reached heap limit|allocation failed|ineffective mark-compacts/i.test(logText);
  const heapMatches = [
    ...[...logText.matchAll(/\((\d+(?:\.\d+)?)\)\s*MB/gi)].map((match) => Number(match[1])),
    ...[...logText.matchAll(/heap limit[^\d]*(\d+(?:\.\d+)?)\s*MB/gi)].map((match) => Number(match[1])),
  ];
  return {
    kind: outOfMemory ? "out-of-memory" : "run-error",
    detectedHeapMiB: heapMatches.length ? Math.max(...heapMatches) : undefined,
    logTail: logText.trim().split(/\r?\n/).filter(Boolean).slice(-12).join("\n") || undefined,
  };
}

const execFileAsync = promisify(execFile);

// The kernel log is the only evidence that the operating system's OOM killer
// sent a SIGKILL. It may be unreadable without privileges; that is recorded.
export async function readKernelLog(run = execFileAsync) {
  const errors = [];
  for (const [command, args] of [["dmesg", []], ["journalctl", ["-k", "--no-pager", "-n", "5000"]]]) {
    try {
      const { stdout } = await run(command, args, { maxBuffer: 64 * 1024 * 1024 });
      return { text: stdout };
    } catch (error) {
      errors.push(`${command}: ${error.message.split("\n")[0]}`);
    }
  }
  return { unavailable: errors.join("; ") };
}

export function kernelOomEvidence(kernelLog = "", pid) {
  if (!pid) return undefined;
  const pidPattern = new RegExp(`(?:Killed process|pid=)\\s*${pid}\\b`);
  const lines = kernelLog.split(/\r?\n/).filter((line) => pidPattern.test(line) && /oom|out of memory/i.test(line));
  return lines.length ? lines.join("\n") : undefined;
}

// Why one managed process ended: Node's own heap limit, the operating
// system's OOM killer, another SIGKILL, or any other exit.
export function processExitCause(outcome) {
  if (outcome.heapOutOfMemory) return "heap-out-of-memory";
  if (outcome.kernelOomKill) return "os-out-of-memory";
  if (outcome.signal === "SIGKILL") return "killed";
  return "crashed";
}

export const MEMORY_FAILURE_CAUSES = new Set(["heap-out-of-memory", "os-out-of-memory"]);

// Attributes a repetition's failure to the process that exited unexpectedly first.
// A process that dies can make the other one fail, so later exits are
// consequences. Without an exit, a round that never became correct is charged
// to the service; anything else is a benchmark run error.
export function classifyFailure(processes, error) {
  const exited = [processes.service, processes.mock]
    .filter((outcome) => outcome?.unexpectedExit)
    .sort((a, b) => (Date.parse(a.exitedAt) || 0) - (Date.parse(b.exitedAt) || 0));
  const culprit = exited[0];
  if (culprit) {
    const cause = processExitCause(culprit);
    return { kind: `${culprit.process}-${cause}`, failedProcess: culprit.process, cause };
  }
  if (error?.code === "AGGREGATE_TIMEOUT") return { kind: "service-timeout", failedProcess: "service", cause: "timeout" };
  return { kind: "run-error", failedProcess: undefined, cause: "run-error" };
}

async function inspectProcess(snapshot, kernelLog) {
  if (!snapshot?.started) return snapshot;
  let logText = "";
  try { logText = await fsp.readFile(snapshot.log, "utf8"); } catch {}
  const logClassification = classifyFailureLog(logText);
  const { log, ...outcome } = snapshot;
  const heapOutOfMemory = logClassification.kind === "out-of-memory" ? {
    logObservedAt: snapshot.oomLogObservedAt,
    evidence: snapshot.oomLogEvidence,
    detectedHeapMiB: logClassification.detectedHeapMiB,
  } : undefined;
  const kernelOomKill = snapshot.unexpectedExit && snapshot.signal === "SIGKILL"
    ? kernelOomEvidence(kernelLog?.text, snapshot.pid)
    : undefined;
  delete outcome.oomLogObservedAt;
  delete outcome.oomLogEvidence;
  return {
    ...outcome,
    ...(heapOutOfMemory ? { heapOutOfMemory } : {}),
    ...(kernelOomKill ? { kernelOomKill } : {}),
    ...(logClassification.logTail ? { logTail: logClassification.logTail } : {}),
  };
}

export async function inspectFailure(error, kernelLogReader = readKernelLog) {
  const snapshots = error.processes ?? {};
  const needsKernelLog = Object.values(snapshots).some((item) => item?.unexpectedExit && item.signal === "SIGKILL");
  const kernelLog = needsKernelLog ? await kernelLogReader() : undefined;
  const processes = {
    service: await inspectProcess(snapshots.service, kernelLog),
    mock: await inspectProcess(snapshots.mock, kernelLog),
  };
  return {
    // Without a benchmark record the failure happened while launching or
    // checking the processes, before the benchmark started.
    ...(error.benchmarkFailure ?? { stage: "launch" }),
    ...classifyFailure(processes, error),
    message: error.message,
    errorDetails: errorDetails(error),
    processes,
    ...(kernelLog?.unavailable ? { kernelLogUnavailable: kernelLog.unavailable } : {}),
  };
}

function fixedMetrics(records, fields) {
  return Object.fromEntries(fields.map((field) => {
    const values = records.map((record) => record[field]).filter(Number.isFinite);
    const first = values[0];
    if (values.length !== records.length || !values.every((value) => value === first)) {
      throw new Error(`Deterministic workload mismatch for ${field}: ${values.join(", ")}`);
    }
    return [field, {
      value: first,
      consistent: true,
      observed: [first],
    }];
  }));
}

function bootstrapOptions(label) {
  return {
    iterations: BOOTSTRAP.iterations,
    confidenceLevel: BOOTSTRAP.confidenceLevel,
    seed: seedForLabel(BOOTSTRAP.seed, label),
    label,
  };
}

async function aggregateRunFiles(outputs) {
  const runs = [];
  for (const output of outputs) {
    try { runs.push(await readRun(output, { allowPartial: true })); } catch {}
  }
  const startupRecords = runs.filter(({ startup }) => startup).map(({ startup }) => ({
    ...startup,
    peakRssMiB: startup.resources?.peakRssBytes / 1024 / 1024,
    peakHeapMiB: startup.resources?.peakHeapUsedBytes / 1024 / 1024,
    cpuSeconds: ((startup.resources?.cpuUserMicros ?? 0) + (startup.resources?.cpuSystemMicros ?? 0)) / 1e6,
  }));
  const yearRecords = runs.filter(({ year }) => year).map(({ year }) => year);
  const roundNumbers = [...new Set(runs.flatMap(({ rounds }) => rounds.map(({ round }) => round)))].sort((a, b) => a - b);
  return {
    startup: startupRecords.length ? {
      workload: fixedMetrics(startupRecords, ["initialObservations", "initialTriples"]),
      performance: bootstrapRecords(startupRecords, STARTUP_PERFORMANCE_FIELDS, bootstrapOptions("startup")),
    } : undefined,
    year: yearRecords.length ? {
      workload: fixedMetrics(yearRecords, ["rounds", "finalObservations", "finalTriples"]),
      performance: bootstrapRecords(yearRecords, YEAR_FIELDS, bootstrapOptions("year")),
    } : undefined,
    rounds: roundNumbers.map((round) => {
      const records = runs.flatMap((run) => run.rounds.filter((record) => record.round === round));
      return {
        round,
        workload: fixedMetrics(records, WORKLOAD_FIELDS),
        latency: bootstrapRecords(records, LATENCY_FIELDS, bootstrapOptions(`round.${round}.latency`)),
        resources: bootstrapRecords(records, RESOURCE_FIELDS, bootstrapOptions(`round.${round}.resources`)),
      };
    }),
  };
}

function memoryFailureSummary(failure) {
  const service = failure.processes?.service ?? {};
  return {
    repetition: failure.repetition,
    kind: failure.kind,
    stage: failure.stage,
    round: failure.round,
    roundProgress: failure.roundProgress,
    lastCompletedRound: failure.lastCompletedRound,
    lastCompletedObservations: failure.lastCompletedObservations,
    lastCompletedTriples: failure.lastCompletedTriples,
    serviceObservationsAtLastSample: failure.serviceObservationsAtLastSample,
    serviceTriplesAtLastSample: failure.serviceTriplesAtLastSample,
    serviceMemoryAtLastSample: failure.serviceMemoryAtLastSample,
    triplesAtFailure: failure.triplesAtFailure,
    requestFailedAt: failure.failedAt,
    serviceStartedAt: service.startedAt,
    oomLogObservedAt: service.heapOutOfMemory?.logObservedAt,
    serviceExitedAt: service.exitedAt,
    detectedHeapMiB: service.heapOutOfMemory?.detectedHeapMiB,
    evidence: service.heapOutOfMemory?.evidence ?? service.kernelOomKill,
  };
}

export async function runFullExperiment(config) {
  const startedAt = new Date().toISOString();
  const directory = path.join(projectRoot, "results", `experiment-${startedAt.replace(/[:.]/g, "-")}`);
  await fsp.mkdir(directory, { recursive: true });
  await buildService(path.join(directory, "build.log"));

  const { podCount, days, repetitions, writeConcurrency } = config.experiment;
  const relative = (file) => (file ? path.relative(directory, file) : undefined);
  const runs = [];
  const failures = [];
  // A failed repetition is not retried: the workload is deterministic, so a
  // failure such as an out-of-memory is itself the result.
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    console.log(`[experiment ${repetition}/${repetitions}] serviceVersion=${config.service.version} distribution=${config.service.distribution} pods=${podCount} days=${days} writeConcurrency=${writeConcurrency}`);
    try {
      const trial = await runManagedTrial(config, repetition, directory);
      runs.push({ repetition, status: "success", output: trial.output, log: trial.log, mockLog: trial.mockLog });
    } catch (error) {
      const failure = {
        repetition,
        ...await inspectFailure(error),
        output: error.runOutput,
        log: error.runLog,
        mockLog: error.mockLog,
        observedAt: new Date().toISOString(),
      };
      failures.push(failure);
      runs.push({ repetition, status: "failure", kind: failure.kind, output: error.runOutput, log: error.runLog, mockLog: error.mockLog });
      console.error(
        `[experiment ${repetition}] failed (kind=${failure.kind}): ${error.message}\n` +
        JSON.stringify({
          kind: failure.kind,
          failedProcess: failure.failedProcess,
          stage: failure.stage,
          round: failure.round,
          lastCompletedRound: failure.lastCompletedRound,
          processes: Object.fromEntries(Object.entries(failure.processes).map(([name, item]) => [name, {
            exitedAt: item?.exitedAt,
            exitCode: item?.exitCode,
            signal: item?.signal,
            unexpectedExit: item?.unexpectedExit,
            heapOutOfMemory: item?.heapOutOfMemory,
            kernelOomKill: item?.kernelOomKill,
          }])),
          errorDetails: errorDetails(error),
        }),
      );
    }
  }

  const successful = runs.filter(({ status }) => status === "success").length;
  const summary = {
    type: "experiment-summary",
    status: successful === repetitions ? "complete" : "partial",
    startedAt,
    completedAt: new Date().toISOString(),
    serviceVersion: config.service.version,
    distribution: config.service.distribution,
    podCount,
    days,
    writeConcurrency,
    requestedRepetitions: repetitions,
    repetitions: successful,
    statistics: {
      method: "repetition-level percentile bootstrap",
      confidenceInterval: "percentile bootstrap",
      ...BOOTSTRAP,
      latencyPopulation: "completed days from all repetitions; days are analyzed separately and sample size may decline after failures",
    },
    runs: runs.map((run) => ({ ...run, output: relative(run.output), log: relative(run.log), mockLog: relative(run.mockLog) })),
    failures: failures.map((failure) => ({
      ...failure,
      output: relative(failure.output),
      log: relative(failure.log),
      mockLog: relative(failure.mockLog),
    })),
    failureKinds: Object.fromEntries(
      [...new Set(failures.map(({ kind }) => kind))].map((kind) => [kind, failures.filter((item) => item.kind === kind).length]),
    ),
    serviceMemoryFailures: failures
      .filter((failure) => failure.failedProcess === "service" && MEMORY_FAILURE_CAUSES.has(failure.cause))
      .map(memoryFailureSummary),
    reliability: {
      runs: runs.length,
      successfulRuns: successful,
      failedRuns: failures.length,
      failureRate: binomialConfidenceInterval(failures.length, runs.length, BOOTSTRAP.confidenceLevel),
    },
    ...await aggregateRunFiles(runs.map(({ output }) => output).filter(Boolean)),
  };
  const output = path.join(directory, "summary.json");
  await fsp.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  const report = await generateExperimentReport(summary, path.join(directory, "report.html"));
  return { output, report, directory, repetitions: successful };
}
