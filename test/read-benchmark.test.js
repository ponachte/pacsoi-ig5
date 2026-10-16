import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkpoints, csvDifference, runReadBenchmark, withinRounding } from "../src/benchmark/read-benchmark.js";

test("checkpoints include the first day, every N-th day and the last day", () => {
  assert.deepEqual(checkpoints(365, 100), [1, 100, 200, 300, 365]);
  assert.deepEqual(checkpoints(3, 30), [1, 3]);
});

test("reports the largest difference per column", () => {
  const header = "month,avg_weight,stdev,q25,q75,count";
  assert.deepEqual(
    csvDifference(`${header}\n0,1.00,2.00,3.00,4.00,5`, `${header}\n0,1.01,2.00,3.00,4.00,5`),
    { average: 0.010000000000000009, stdev: 0, q25: 0, q75: 0, count: 0 },
  );
  assert.equal(csvDifference(`${header}\n0,1,1,1,1,1`, `${header}\n1,1,1,1,1,1`).monthsDiffer, true);
  assert.equal(withinRounding({ average: 0.01, stdev: 0, q25: 0, q75: 0, count: 0 }), true);
  assert.equal(withinRounding({ average: 0.02, stdev: 0, q25: 0, q75: 0, count: 0 }), false);
  assert.equal(withinRounding({ average: 0, stdev: 0, q25: 0, q75: 0, count: 1 }), false);
});

test("both strategies of the built service agree on a small replay", async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "read-benchmark-"));
  try {
    const result = await runReadBenchmark({ podCount: 20, days: 40, reads: 2, every: 20 }, { output, log: () => {} });
    assert.equal(result.allIdentical, true);
    const records = (await fs.readFile(result.output, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(records.map((record) => record.type), ["header", "checkpoint", "checkpoint", "checkpoint", "summary"]);
    assert.deepEqual(records.filter((r) => r.type === "checkpoint").map((r) => r.observations), [40, 420, 820]);
  } finally {
    await fs.rm(output, { recursive: true, force: true });
  }
});
