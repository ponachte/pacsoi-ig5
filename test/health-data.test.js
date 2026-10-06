import test from "node:test";
import assert from "node:assert/strict";
import { roundRecords, topologyRecords } from "../src/kvasir/slices.js";

const config = {
  kvasir: { serverUrl: "https://kvasir.example" },
  experiment: { podPrefix: "latency", podCount: 2 },
};

test("startup topology adds only the local patient identity", () => {
  const records = topologyRecords(config, "latency001");
  assert.equal(records.some((record) => record["@type"] === "sosa:Observation"), false);
  assert.deepEqual(records, [{
    "@id": "https://kvasir.example/latency001/patients/main",
    "@type": "foaf:Person",
  }]);
});

test("first round adds one procedure and the requested number of weights", () => {
  const { records, values } = roundRecords(config, "latency001", 1, 3);
  assert.equal(values.length, 3);
  assert.equal(records.filter((record) => record["@type"] === "sphn:MedicalProcedure").length, 1);
  assert.equal(records.filter((record) => record["@type"] === "sosa:Observation").length, 3);
});

test("later rounds add weights without duplicating the procedure", () => {
  const { records } = roundRecords(config, "latency001", 2, 2);
  assert.equal(records.some((record) => record["@type"] === "sphn:MedicalProcedure"), false);
  assert.equal(records.filter((record) => record["@type"] === "sosa:Observation").length, 2);
});
