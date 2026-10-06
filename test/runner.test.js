import test from "node:test";
import assert from "node:assert/strict";
import { parseWeightCsv, weightSnapshot } from "../src/benchmark/runner.js";

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
