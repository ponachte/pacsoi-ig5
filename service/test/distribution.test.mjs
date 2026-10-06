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
