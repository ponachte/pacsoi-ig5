import assert from "node:assert/strict";
import test from "node:test";
import { parsePodSources, readConfig } from "../dist/config.js";

test("parses and normalizes pod source URLs", () => {
  assert.deepEqual(
    parsePodSources('["https://pods.example/alice/", "http://pods.example/bob"]'),
    ["https://pods.example/alice", "http://pods.example/bob"],
  );
});

test("rejects invalid pod source configuration", () => {
  assert.throws(() => parsePodSources(undefined), /SOURCES must be set/);
  assert.throws(() => parsePodSources("not-json"), /JSON array/);
  assert.throws(() => parsePodSources("[]"), /non-empty/);
  assert.throws(() => parsePodSources('["file:///tmp/pod"]'), /http or https/);
  assert.throws(
    () => parsePodSources('["https://pods.example/alice", "https://pods.example/alice/"]'),
    /duplicate/,
  );
});

test("reads the three combined-slice names", () => {
  assert.deepEqual(readConfig({
    SOURCES: '["https://pods.example/alice"]',
    PATIENT_SLICE: "/pacsoi-latency/",
    BAR_PROCEDURE_SLICE: "pacsoi-latency",
    WEIGHT_SLICE: " pacsoi-latency ",
  }), {
    podBaseUrls: ["https://pods.example/alice"],
    patientSlice: "pacsoi-latency",
    procedureSlice: "pacsoi-latency",
    weightSlice: "pacsoi-latency",
  });
});
