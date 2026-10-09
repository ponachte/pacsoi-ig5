import test from "node:test";
import assert from "node:assert/strict";
import { parseWeightCsv, resourceSummary, weightSnapshot } from "../src/benchmark/runner.js";

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
