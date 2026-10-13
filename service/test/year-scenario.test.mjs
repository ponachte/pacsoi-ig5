import assert from "node:assert/strict";
import test from "node:test";
import { WeightDistribution } from "../dist/distribution.js";
import { addDay, createExpectation, distributionMismatch, weightSnapshot } from "../../src/benchmark/runner.js";
import { observation, PROCEDURE_AT, patientUrl, podId } from "../../src/mock/data.js";

test("the lab's per-month expectation matches the service for a simulated year", () => {
  const podCount = 3;
  const distribution = new WeightDistribution();
  const expected = createExpectation();
  for (let number = 1; number <= podCount; number += 1) {
    distribution.addProcedure(patientUrl("http://mock", podId(number, podCount)), new Date(PROCEDURE_AT));
  }
  for (let day = 0; day <= 365; day += 1) {
    for (let number = 1; number <= podCount; number += 1) {
      const id = podId(number, podCount);
      const { sosa_hasResult: result } = observation("http://mock", id, number, day);
      distribution.addObservation(patientUrl("http://mock", id), result.saref_hasValue, new Date(result.saref_hasTimestamp));
    }
    addDay(expected, podCount, day);
  }

  const snapshot = weightSnapshot(distribution.toCSV());
  assert.equal(snapshot.rows.length, 13);
  assert.equal(snapshot.count, podCount * 366);
  assert.equal(distributionMismatch(snapshot, expected), undefined);
});
