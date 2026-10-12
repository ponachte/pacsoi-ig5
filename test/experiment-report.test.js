import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateExperimentReport } from "../src/experiment-report.js";
import { classifyFailureLog, stopProcess, watchProcessExit } from "../src/benchmark/full-experiment.js";

function distribution(estimate, lower, upper) {
  return { sampleSize: 10, percentiles: { p50: { estimate, ci: { confidenceLevel: 0.95, lower, upper } } } };
}

test("generates a self-contained bootstrap experiment report", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-experiment-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "report.html");
  const summary = {
    status: "complete", completedAt: "2026-10-12T10:00:00Z", repetitions: 10,
    statistics: { iterations: 10_000, confidenceLevel: 0.95 },
    requestedRepetitions: 10,
    reliability: { attempts: 10, failedAttempts: 1, failureRate: { estimate: 0.1, ci: { lower: 0.02, upper: 0.4 } } },
    failures: [{ repetition: 3, attempt: 1, kind: "out-of-memory", round: 8, lastCompletedRound: 7, lastCompletedTriples: 1000, serviceTriplesAtLastSample: 1070, triplesAtFailure: 1100, failedAt: "2026-10-12T09:00:00Z" }],
    outOfMemoryFailures: [{ repetition: 3 }],
    rounds: [{
      round: 1,
      workload: { cumulativeTriples: { value: 120 } },
      latency: { propagationMs: distribution(10, 8, 12), endToEndMs: distribution(20, 18, 24), writePhaseMs: distribution(8, 7, 9) },
      writeLatency: { p95Ms: distribution(4, 3, 5) }, throughput: {}, resources: {},
    }],
  };

  await generateExperimentReport(summary, output);
  const html = await fs.readFile(output, "utf8");
  assert.match(html, /Median round latency with bootstrap confidence intervals/);
  assert.match(html, /Shaded bands/);
  assert.match(html, /Typical run write p95/);
  assert.match(html, /Service triples/);
  assert.match(html, /Mock triples/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

test("classifies Node heap exhaustion and extracts the detected heap size", () => {
  const result = classifyFailureLog("Mark-Compact 3900 (4129.3) MB\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
  assert.equal(result.kind, "out-of-memory");
  assert.equal(result.detectedHeapMiB, 4129.3);
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
