import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateExperimentReport } from "../src/experiment-report.js";
import {
  classifyFailure,
  classifyFailureLog,
  heapArguments,
  inspectFailure,
  kernelOomEvidence,
  readKernelLog,
  startProcess,
  stopProcess,
  watchProcessExit,
} from "../src/benchmark/full-experiment.js";

function distribution(estimate, lower, upper) {
  return { sampleSize: 10, percentiles: { p50: { estimate, ci: { confidenceLevel: 0.95, lower, upper } } } };
}

test("generates a self-contained bootstrap experiment report", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-experiment-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "report.html");
  const summary = {
    status: "partial", completedAt: "2026-10-12T10:00:00Z", repetitions: 9, serviceVersion: "level",
    podCount: 10_000, days: 365,
    statistics: { iterations: 10_000, confidenceLevel: 0.95 },
    requestedRepetitions: 10,
    reliability: { runs: 10, successfulRuns: 9, failedRuns: 1, failureRate: { estimate: 0.1, ci: { lower: 0.02, upper: 0.4 } } },
    failures: [{
      repetition: 3, kind: "service-heap-out-of-memory", failedProcess: "service", cause: "heap-out-of-memory",
      stage: "round", round: 8, lastCompletedRound: 7,
      lastCompletedTriples: 1000, serviceTriplesAtLastSample: 1070, triplesAtFailure: 1100,
      serviceMemoryAtLastSample: { rssBytes: 4096 * 1024 * 1024 },
      failedAt: "2026-10-12T09:00:00Z",
      processes: {
        service: {
          process: "service", started: true, unexpectedExit: true, exitCode: 134, signal: null,
          exitedAt: "2026-10-12T09:00:16Z",
          heapOutOfMemory: { logObservedAt: "2026-10-12T09:00:15Z", detectedHeapMiB: 4135 },
        },
        mock: { process: "mock", started: true, unexpectedExit: false, signal: "SIGTERM" },
      },
    }],
    serviceMemoryFailures: [{ repetition: 3 }],
    year: { performance: { yearWallMs: distribution(3_600_000, 3_500_000, 3_700_000), sumEndToEndMs: distribution(3_000_000, 2_900_000, 3_100_000) } },
    rounds: [{
      round: 1,
      workload: { cumulativeTriples: { value: 120 } },
      latency: { propagationMs: distribution(10, 8, 12), endToEndMs: distribution(20, 18, 24), pushMs: distribution(8, 7, 9) },
      resources: {},
    }],
  };

  await generateExperimentReport(summary, output);
  const html = await fs.readFile(output, "utf8");
  assert.match(html, /Median daily latency with bootstrap confidence intervals/);
  assert.match(html, /Shaded bands/);
  assert.match(html, /pods × /);
  assert.match(html, /Service version/);
  assert.match(html, /Year: first push → last day correct/);
  assert.match(html, /End-to-end lower bound p50/);
  assert.match(html, /level/);
  assert.match(html, /Service triples/);
  assert.match(html, /Mock triples/);
  assert.match(html, /OOM log observed/);
  assert.match(html, /Service memory failures/);
  assert.match(html, /Mock failures/);
  assert.match(html, /Service RSS \(last sample\)/);
  assert.match(html, /2026-10-12T09:00:15Z/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

test("passes an explicit heap limit to managed children only when configured", () => {
  assert.deepEqual(heapArguments(undefined), []);
  assert.deepEqual(heapArguments(16_384), ["--max-old-space-size=16384"]);
});

test("classifies Node heap exhaustion and extracts the detected heap size", () => {
  const result = classifyFailureLog([
    "Mark-Compact 3949.4 (4132.0) -> 3934.8 (4133.3) MB, 2001.67 ms allocation failure; scavenge might not succeed",
    "Mark-Compact 3951.2 (4133.8) -> 3936.5 (4135.0) MB, 2066.32 ms allocation failure; scavenge might not succeed",
    "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory",
  ].join("\n"));
  assert.equal(result.kind, "out-of-memory");
  assert.equal(result.detectedHeapMiB, 4135);
});

test("records when a managed child emits Node's fatal heap error", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-oom-log-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logFile = path.join(directory, "service.log");
  const child = startProcess(process.execPath, [
    "-e",
    "process.stderr.write('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\\n')",
  ], { cwd: directory }, logFile);

  await child.exited;
  await child.logFinished;

  assert.match(child.oomLogObservedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(child.oomLogEvidence, /FATAL ERROR:.*JavaScript heap out of memory/);
  assert.match(child.exitedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("does not wait for another exit when stopping a process that exited by signal", async () => {
  let killCalled = false;
  const child = {
    exitCode: null,
    signalCode: "SIGABRT",
    expectedStop: false,
    logFinished: Promise.resolve(),
    exited: Promise.resolve({ code: null, signal: "SIGABRT" }),
    kill() {
      killCalled = true;
    },
  };

  await stopProcess(child, 10);

  assert.equal(child.expectedStop, true);
  assert.equal(killCalled, false);
});

test("aborts an active attempt as soon as its managed service exits", async () => {
  const lifecycle = new AbortController();
  const child = {
    expectedStop: false,
    exited: Promise.resolve({ code: null, signal: "SIGKILL" }),
  };

  const error = await watchProcessExit(child, "service", "/tmp/service.log", lifecycle);

  assert.equal(error.processLabel, "service");
  assert.equal(error.processSignal, "SIGKILL");
  assert.match(error.message, /service exited unexpectedly with signal SIGKILL/);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(lifecycle.signal.reason, error);
});

const exited = (process, at, extra = {}) => ({
  process, started: true, unexpectedExit: true, exitedAt: at, exitCode: null, signal: null, ...extra,
});
const stopped = (process) => ({ process, started: true, unexpectedExit: false, signal: "SIGTERM" });

test("attributes a failure to the process that exited unexpectedly first", () => {
  assert.deepEqual(
    classifyFailure({
      service: exited("service", "2026-10-12T09:00:02Z", { heapOutOfMemory: { detectedHeapMiB: 4000 } }),
      mock: stopped("mock"),
    }),
    { kind: "service-heap-out-of-memory", failedProcess: "service", cause: "heap-out-of-memory" },
  );
  assert.deepEqual(
    classifyFailure({
      service: exited("service", "2026-10-12T09:00:05Z", { exitCode: 1 }),
      mock: exited("mock", "2026-10-12T09:00:01Z", { heapOutOfMemory: {} }),
    }),
    { kind: "mock-heap-out-of-memory", failedProcess: "mock", cause: "heap-out-of-memory" },
  );
  assert.equal(classifyFailure({
    service: exited("service", "2026-10-12T09:00:02Z", { signal: "SIGKILL", kernelOomKill: "Out of memory: Killed process 42" }),
    mock: stopped("mock"),
  }).kind, "service-os-out-of-memory");
  assert.equal(classifyFailure({
    service: exited("service", "2026-10-12T09:00:02Z", { signal: "SIGKILL" }), mock: stopped("mock"),
  }).kind, "service-killed");
  assert.equal(classifyFailure({
    service: exited("service", "2026-10-12T09:00:02Z", { exitCode: 1 }), mock: stopped("mock"),
  }).kind, "service-crashed");
});

test("a deliberate stop never counts as a crash, even when it needed SIGKILL", () => {
  const service = { process: "service", started: true, unexpectedExit: false, signal: "SIGKILL" };
  assert.deepEqual(classifyFailure({ service, mock: stopped("mock") }, new Error("bad response")), {
    kind: "run-error", failedProcess: undefined, cause: "run-error",
  });
  const timeout = Object.assign(new Error("Timed out"), { code: "AGGREGATE_TIMEOUT" });
  assert.equal(classifyFailure({ service, mock: stopped("mock") }, timeout).kind, "service-timeout");
});

test("finds OOM-killer evidence for one pid in the kernel log", () => {
  const log = [
    "[ 10.0] node invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0",
    "[ 10.1] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),task=node,pid=4242,uid=1000",
    "[ 10.2] Out of memory: Killed process 4242 (node) total-vm:9000000kB, anon-rss:7000000kB",
    "[ 11.0] Out of memory: Killed process 42420 (other) total-vm:1kB",
  ].join("\n");
  assert.match(kernelOomEvidence(log, 4242), /pid=4242[\s\S]*Killed process 4242 /);
  assert.doesNotMatch(kernelOomEvidence(log, 4242), /42420/);
  assert.equal(kernelOomEvidence(log, 7), undefined);
  assert.equal(kernelOomEvidence(log, undefined), undefined);
});

test("falls back to journalctl and records when the kernel log is unreadable", async () => {
  const calls = [];
  const fallback = await readKernelLog(async (command) => {
    calls.push(command);
    if (command === "dmesg") throw new Error("dmesg: read kernel buffer failed: Operation not permitted");
    return { stdout: "kernel text" };
  });
  assert.deepEqual(calls, ["dmesg", "journalctl"]);
  assert.deepEqual(fallback, { text: "kernel text" });
  const unavailable = await readKernelLog(async (command) => { throw new Error(`${command} denied`); });
  assert.match(unavailable.unavailable, /dmesg: dmesg denied; journalctl: journalctl denied/);
});

test("inspects both process logs and attaches kernel evidence only to an unexpected SIGKILL", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-inspect-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const serviceLog = path.join(directory, "service.log");
  const mockLog = path.join(directory, "mock.log");
  await fs.writeFile(serviceLog, "started\n");
  await fs.writeFile(mockLog, "Mark-Compact 2000 (2050.1) MB\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
  const error = Object.assign(new Error("mock server exited unexpectedly"), {
    benchmarkFailure: { stage: "round", round: 3, lastCompletedRound: 2 },
    processes: {
      service: { process: "service", started: true, log: serviceLog, pid: 11, unexpectedExit: true, signal: "SIGKILL", exitedAt: "2026-10-12T09:00:05Z" },
      mock: {
        process: "mock", started: true, log: mockLog, pid: 12, unexpectedExit: true, exitCode: 134, signal: null,
        exitedAt: "2026-10-12T09:00:01Z", oomLogObservedAt: "2026-10-12T09:00:00Z", oomLogEvidence: "FATAL ERROR: Reached heap limit",
      },
    },
  });
  let reads = 0;
  const detail = await inspectFailure(error, async () => {
    reads += 1;
    return { text: "Out of memory: Killed process 11 (node)" };
  });

  assert.equal(reads, 1);
  assert.equal(detail.kind, "mock-heap-out-of-memory");
  assert.equal(detail.failedProcess, "mock");
  assert.equal(detail.round, 3);
  assert.equal(detail.processes.mock.heapOutOfMemory.detectedHeapMiB, 2050.1);
  assert.equal(detail.processes.mock.heapOutOfMemory.logObservedAt, "2026-10-12T09:00:00Z");
  assert.equal(detail.processes.service.kernelOomKill, "Out of memory: Killed process 11 (node)");
  assert.equal(detail.processes.service.log, undefined);
});

test("marks a child that exits by itself as unexpected and a stopped child as expected", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-exit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const crashed = startProcess(process.execPath, ["-e", "process.exit(3)"], { cwd: directory }, path.join(directory, "a.log"));
  await crashed.exited;
  await stopProcess(crashed, 100);
  assert.equal(crashed.unexpectedExit, true);

  const running = startProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: directory }, path.join(directory, "b.log"));
  await stopProcess(running, 1000);
  assert.equal(running.unexpectedExit, false);
});
