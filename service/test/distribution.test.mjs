import assert from "node:assert/strict";
import test from "node:test";
import { WeightDistribution } from "../dist/distribution.js";

test("buffers out-of-order data and emits the PACSOI CSV contract", () => {
  const distribution = new WeightDistribution();
  const patient = "https://pods.example/alice/patients/main";
  distribution.addObservation(patient, 90, new Date("2020-02-02T10:00:00Z"));
  distribution.addProcedure(patient, new Date("2020-01-15T10:00:00Z"));
  distribution.addPatient(patient);
  distribution.addObservation(patient, 100, new Date("2020-02-03T10:00:00Z"));

  assert.equal(
    distribution.toCSV(),
    "month,avg_weight,stdev,q25,q75,count\n1,95.00,5.00,92.50,97.50,2",
  );
});

test("an empty distribution returns only the header", () => {
  assert.equal(new WeightDistribution().toCSV(), "month,avg_weight,stdev,q25,q75,count");
});

function feed(distribution, observations) {
  for (const [patient, value, timestamp] of observations) {
    distribution.addProcedure(patient, new Date("2020-01-15T10:00:00Z"));
    distribution.addObservation(patient, value, new Date(timestamp));
  }
  return distribution.toCSV();
}

test("the incremental strategy returns the same CSV as recomputing", () => {
  const observations = [
    ["a", 90, "2020-02-02T10:00:00Z"],
    ["b", 100, "2020-02-03T10:00:00Z"],
    ["c", 100, "2020-02-04T10:00:00Z"],
    ["a", 85.5, "2020-03-02T10:00:00Z"],
  ];
  const expected = "month,avg_weight,stdev,q25,q75,count\n1,96.67,4.71,95.00,100.00,3\n2,85.50,0.00,85.50,85.50,1";
  assert.equal(feed(new WeightDistribution("recompute"), observations), expected);
  assert.equal(feed(new WeightDistribution("incremental"), observations), expected);
});

test("both strategies agree on many values with duplicates, read between additions", () => {
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const recompute = new WeightDistribution("recompute");
  const incremental = new WeightDistribution("incremental");
  for (let i = 0; i < 20_000; i += 1) {
    const patient = `p${i % 97}`;
    const value = Number((60 + random() * 70).toFixed(2));
    const timestamp = new Date(Date.UTC(2020, Math.floor(random() * 13), 20));
    for (const distribution of [recompute, incremental]) {
      distribution.addProcedure(patient, new Date("2020-01-15T10:00:00Z"));
      distribution.addObservation(patient, value, timestamp);
    }
    if (i % 2_500 === 0) assert.equal(incremental.toCSV(), recompute.toCSV());
  }
  assert.equal(incremental.toCSV(), recompute.toCSV());
  assert.deepEqual(incremental.stats(), recompute.stats());
});
