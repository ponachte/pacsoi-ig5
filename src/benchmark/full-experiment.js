import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { check } from "../check.js";
import { projectRoot } from "../config.js";
import { delay, fetchWithTimeout } from "../http.js";
import { resetMock } from "../mock/client.js";
import { readRun } from "../report.js";
import { binomialConfidenceInterval, bootstrapRecords, seedForLabel } from "../statistics.js";
import { runExperiment } from "./runner.js";
import { generateExperimentReport } from "../experiment-report.js";

const STARTUP_PERFORMANCE_FIELDS = ["benchmarkWaitMs", "observedServiceUptimeMs", "peakRssMiB", "peakHeapMiB", "cpuSeconds"];
const WORKLOAD_FIELDS = ["observationsAdded", "cumulativeObservations", "triplesAdded", "cumulativeTriples"];
const LATENCY_FIELDS = ["writePhaseMs", "propagationMs", "endToEndMs"];
const WRITE_LATENCY_FIELDS = ["p50Ms", "p95Ms", "p99Ms", "maxMs"];
const RESOURCE_FIELDS = ["peakRssMiB", "peakHeapMiB", "cpuSeconds", "eventLoopP95Ms"];

function localAddress(serverUrl, label) {
  const url = new URL(serverUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    throw new Error(`Automated ${label} lifecycle requires a local http URL, received ${serverUrl}`);
  }
  const host = hostname === "localhost" ? "0.0.0.0" : hostname;
  return { host, port: Number(url.port || 80) };
}

function startProcess(command, args, options, logFile) {
  const output = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(output);
  child.stderr.pipe(output);
  child.once("close", () => output.end());
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
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

async function stopProcess(child, timeoutMs) {
  if (!child) return;
  child.expectedStop = true;
  if (child.exitCode !== null) {
    await child.logFinished;
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  await child.logFinished;
}

async function waitForHealth(url, child, timeoutMs, requestTimeoutMs, label, fetchImpl = fetch) {
  const started = performance.now();
  let latest;
  while (performance.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`${label} exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        url,
        {},
        Math.min(requestTimeoutMs, Math.max(1, timeoutMs - (performance.now() - started))),
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

async function runManagedTrial(config, repetition, attempt, directory) {
  const mockAddress = localAddress(config.mock.serverUrl, "mock");
  const serviceAddress = localAddress(config.service.serverUrl, "service");
  const stem = `repetition-${String(repetition).padStart(3, "0")}-attempt-${attempt}`;
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
      `--public-url=${config.mock.serverUrl}`,
    ], { cwd: projectRoot }, mockLog);
    exitFailures.push(watchProcessExit(mock, "mock server", mockLog, lifecycle));
    await waitForHealth(
      `${config.mock.serverUrl}/health`, mock, config.experiment.startupTimeoutMs,
      config.experiment.requestTimeoutMs, "mock server", managedFetch,
    );
    await resetMock(config, managedFetch);

    service = startProcess(process.execPath, ["service/dist/index.js"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        POD_SERVER_URL: config.mock.serverUrl,
        POD_PREFIX: config.experiment.podPrefix,
        POD_COUNT: String(config.experiment.podCount),
        SLICE_NAME: config.experiment.sliceName,
        PORT: String(serviceAddress.port),
      },
    }, serviceLog);
    exitFailures.push(watchProcessExit(service, "service", serviceLog, lifecycle));
    await waitForHealth(
      `${config.service.serverUrl}/health`, service, config.experiment.startupTimeoutMs,
      config.experiment.requestTimeoutMs, "service", managedFetch,
    );
    await check(config, managedFetch);

    const run = runExperiment(config, managedFetch, { output, repetition, diagnosticFetchImpl: fetch });
    try {
      await Promise.race([run, ...exitFailures.map((exit) => exit.then((error) => { throw error; }))]);
    } catch (error) {
      if (!lifecycle.signal.aborted) lifecycle.abort(error);
      try {
        await run;
      } catch (runErrorWithPartialRecord) {
        throw runErrorWithPartialRecord;
      }
      throw error;
    }
    return { repetition, attempt, output, log: serviceLog, mockLog };
  } catch (error) {
    runError = error;
    error.runOutput ??= output;
    error.runLog = serviceLog;
    error.mockLog = mockLog;
    throw error;
  } finally {
    await stopProcess(service, config.experiment.shutdownTimeoutMs);
    await stopProcess(mock, config.experiment.shutdownTimeoutMs);
    if (runError) {
      runError.serviceExitCode = service?.exitCode;
      runError.serviceSignal = service?.signalCode;
    }
  }
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

async function inspectFailure(error) {
  let logText = "";
  try { logText = await fsp.readFile(error.runLog, "utf8"); } catch {}
  const classification = classifyFailureLog(logText);
  if (classification.kind !== "out-of-memory" && error.serviceSignal === "SIGKILL") {
    classification.kind = "process-killed";
  }
  return {
    ...(error.benchmarkFailure ?? {}),
    ...classification,
    message: error.message,
    serviceExitCode: error.serviceExitCode,
    serviceSignal: error.serviceSignal,
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

function bootstrapOptions(config, label) {
  return {
    iterations: config.experiment.bootstrapIterations,
    confidenceLevel: config.experiment.bootstrapConfidenceLevel,
    seed: seedForLabel(config.experiment.bootstrapSeed, label),
    label,
  };
}

async function aggregateAttemptFiles(attempts, config) {
  const runs = [];
  for (const attempt of attempts) {
    if (!attempt.output) continue;
    try { runs.push(await readRun(attempt.output, { allowPartial: true })); } catch {}
  }
  const startupRecords = runs.filter(({ startup }) => startup).map(({ startup }) => ({
    ...startup,
    peakRssMiB: startup.resources?.peakRssBytes / 1024 / 1024,
    peakHeapMiB: startup.resources?.peakHeapUsedBytes / 1024 / 1024,
    cpuSeconds: ((startup.resources?.cpuUserMicros ?? 0) + (startup.resources?.cpuSystemMicros ?? 0)) / 1e6,
  }));
  const roundNumbers = [...new Set(runs.flatMap(({ rounds }) => rounds.map(({ round }) => round)))].sort((a, b) => a - b);
  return {
    startup: startupRecords.length ? {
      workload: fixedMetrics(startupRecords, ["initialObservations", "initialTriples"]),
      performance: bootstrapRecords(startupRecords, STARTUP_PERFORMANCE_FIELDS, bootstrapOptions(config, "startup")),
    } : undefined,
    rounds: roundNumbers.map((round) => {
      const records = runs.flatMap((run) => run.rounds.filter((record) => record.round === round));
      return {
        round,
        workload: fixedMetrics(records, WORKLOAD_FIELDS),
        latency: bootstrapRecords(records, LATENCY_FIELDS, bootstrapOptions(config, `round.${round}.latency`)),
        writeLatency: bootstrapRecords(records, WRITE_LATENCY_FIELDS, {
          ...bootstrapOptions(config, `round.${round}.writeLatency`),
          includeSecondary: false,
        }),
        throughput: bootstrapRecords(records, ["throughputPerSecond"], bootstrapOptions(config, `round.${round}.throughput`)),
        resources: bootstrapRecords(records, RESOURCE_FIELDS, bootstrapOptions(config, `round.${round}.resources`)),
      };
    }),
  };
}

export async function runFullExperiment(config) {
  const startedAt = new Date().toISOString();
  const id = startedAt.replace(/[:.]/g, "-");
  const directory = path.join(projectRoot, "results", `experiment-${id}`);
  await fsp.mkdir(directory, { recursive: true });
  const buildLog = path.join(directory, "build.log");
  await buildService(buildLog);

  const trials = [];
  const failures = [];
  const attempts = [];
  for (let repetition = 1; repetition <= config.experiment.repetitions; repetition += 1) {
    let completed = false;
    for (let attempt = 1; attempt <= config.experiment.retryCount + 1 && !completed; attempt += 1) {
      try {
        console.log(`[experiment ${repetition}/${config.experiment.repetitions}] attempt ${attempt}`);
        const trial = await runManagedTrial(config, repetition, attempt, directory);
        trials.push(trial);
        attempts.push({ repetition, attempt, status: "success", output: trial.output, log: trial.log, mockLog: trial.mockLog });
        completed = true;
      } catch (error) {
        const detail = await inspectFailure(error);
        const failure = {
          repetition,
          attempt,
          ...detail,
          output: error.runOutput,
          log: error.runLog,
          mockLog: error.mockLog,
          observedAt: new Date().toISOString(),
        };
        failures.push(failure);
        attempts.push({ ...failure, status: "failure", output: error.runOutput, log: error.runLog, mockLog: error.mockLog });
        console.error(`[experiment ${repetition}] attempt ${attempt} failed: ${error.message}`);
      }
    }
    if (!completed) {
      console.error(`[experiment ${repetition}] no successful attempt; continuing with the next repetition`);
    }
  }

  const aggregate = await aggregateAttemptFiles(attempts, config);
  const failureRate = binomialConfidenceInterval(
    failures.length,
    attempts.length,
    config.experiment.bootstrapConfidenceLevel,
  );
  const summary = {
    type: "experiment-summary",
    status: trials.length === config.experiment.repetitions ? "complete" : "partial",
    startedAt,
    completedAt: new Date().toISOString(),
    repetitions: trials.length,
    observationsPerPodPerRound: config.experiment.observationsPerPodPerRound,
    statistics: {
      method: "repetition-level percentile bootstrap",
      confidenceInterval: "percentile bootstrap",
      iterations: config.experiment.bootstrapIterations,
      confidenceLevel: config.experiment.bootstrapConfidenceLevel,
      seed: config.experiment.bootstrapSeed,
      latencyPopulation: "completed rounds from all attempts; rounds are analyzed separately and sample size may decline after failures",
    },
    requestedRepetitions: config.experiment.repetitions,
    trials: trials.map((trial) => ({
      ...trial,
      output: path.relative(directory, trial.output),
      log: path.relative(directory, trial.log),
      mockLog: path.relative(directory, trial.mockLog),
    })),
    attempts: attempts.map((attempt) => ({
      ...attempt,
      output: attempt.output ? path.relative(directory, attempt.output) : undefined,
      log: attempt.log ? path.relative(directory, attempt.log) : undefined,
      mockLog: attempt.mockLog ? path.relative(directory, attempt.mockLog) : undefined,
    })),
    failures: failures.map((failure) => ({
      ...failure,
      output: failure.output ? path.relative(directory, failure.output) : undefined,
      log: failure.log ? path.relative(directory, failure.log) : undefined,
      mockLog: failure.mockLog ? path.relative(directory, failure.mockLog) : undefined,
    })),
    outOfMemoryFailures: failures.filter((failure) => failure.kind === "out-of-memory").map((failure) => ({
      repetition: failure.repetition,
      attempt: failure.attempt,
      failedAt: failure.failedAt ?? failure.observedAt,
      stage: failure.stage,
      round: failure.round,
      lastCompletedRound: failure.lastCompletedRound,
      lastCompletedTriples: failure.lastCompletedTriples,
      serviceTriplesAtLastSample: failure.serviceTriplesAtLastSample,
      triplesAtFailure: failure.triplesAtFailure,
      detectedHeapMiB: failure.detectedHeapMiB,
    })),
    reliability: {
      attempts: attempts.length,
      successfulAttempts: trials.length,
      failedAttempts: failures.length,
      failureRate,
    },
    ...aggregate,
  };
  const output = path.join(directory, "summary.json");
  await fsp.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  const report = await generateExperimentReport(summary, path.join(directory, "report.html"));
  return { output, report, directory, repetitions: trials.length };
}
