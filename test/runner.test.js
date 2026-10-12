import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseWeightCsv, resourceSummary, runExperiment, weightSnapshot } from "../src/benchmark/runner.js";

test("PACSOI weight CSV is parsed into a cumulative completion snapshot", () => {
  const csv = "month,avg_weight,stdev,q25,q75,count\n1,82.50,0.50,82.25,82.75,2";
  assert.deepEqual(parseWeightCsv(csv), [
    { month: 1, average: 82.5, stdev: 0.5, q25: 82.25, q75: 82.75, count: 2 },
  ]);
  assert.deepEqual(weightSnapshot(csv), {
    rows: [{ month: 1, average: 82.5, stdev: 0.5, q25: 82.25, q75: 82.75, count: 2 }],
    count: 2,
    average: 82.5,
  });
});

test("an empty PACSOI distribution has zero observations", () => {
  assert.deepEqual(weightSnapshot("month,avg_weight,stdev,q25,q75,count"), {
    rows: [],
    count: 0,
    average: undefined,
  });
});

test("service resource samples are summarized for each round", () => {
  const samples = [
    { process: { rss: 100, maxRssBytes: 120, heapUsed: 40, cpuUserMicros: 10, cpuSystemMicros: 5 }, eventLoop: { p95Ms: 1 } },
    { process: { rss: 150, maxRssBytes: 170, heapUsed: 60, cpuUserMicros: 40, cpuSystemMicros: 15 }, eventLoop: { p95Ms: 3 } },
  ];
  assert.deepEqual(resourceSummary(samples), {
    peakRssBytes: 170,
    peakHeapUsedBytes: 60,
    peakEventLoopP95Ms: 3,
    cpuUserMicros: 30,
    cpuSystemMicros: 10,
    samples,
  });
});

test("records the observed triple count when the service fails during startup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-failed-run-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "failed.ndjson");
  const metrics = {
    uptimeSeconds: 1,
    process: { rss: 100, maxRssBytes: 100, heapUsed: 50, cpuUserMicros: 1, cpuSystemMicros: 1 },
    eventLoop: { p95Ms: 1 },
  };
  const fetchImpl = async (url) => {
    if (url.endsWith("/metrics") && url.startsWith("http://service")) {
      return new Response(JSON.stringify(metrics), { status: 200 });
    }
    if (url.endsWith("/w-dist")) throw new Error("service process exited");
    if (url.endsWith("/metrics") && url.startsWith("http://mock")) {
      return new Response(JSON.stringify({ observations: 1, triples: 12 }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const config = {
    mock: { serverUrl: "http://mock" }, service: { serverUrl: "http://service" },
    experiment: {
      podCount: 1, initialObservationsPerPod: 1, resourceSampleIntervalMs: 1000,
      timeoutMs: 1000, pollIntervalMs: 1, iterations: 1,
    },
  };

  await assert.rejects(runExperiment(config, fetchImpl, { output, repetition: 2 }), /service process exited/);
  const records = (await fs.readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  const [failure] = records;
  assert.equal(failure.type, "failure");
  assert.equal(failure.repetition, 2);
  assert.equal(failure.stage, "startup");
  assert.equal(failure.lastCompletedRound, 0);
  assert.equal(failure.lastCompletedObservations, 0);
  assert.equal(failure.lastCompletedTriples, 0);
  assert.equal(failure.observationsAtFailure, 1);
  assert.equal(failure.triplesAtFailure, 12);
  assert.deepEqual(failure.mockMetrics, { observations: 1, triples: 12 });
  assert.equal(failure.requestTimeoutMs, 30_000);
  assert.match(failure.error, /Read weight distribution failed .*http:\/\/service\/w-dist.*service process exited/);
  assert.equal(failure.errorDetails.request.operation, "Read weight distribution");
  assert.equal(failure.errorDetails.request.url, "http://service/w-dist");
  assert.equal(failure.errorDetails.cause.message, "service process exited");
});
