import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";

test("configuration requires only the mock and standalone service", () => {
  const config = validateConfig({
    mock: { serverUrl: "http://mock.example/" },
    service: { serverUrl: "http://service.example/" },
    experiment: {},
  });
  assert.equal(config.mock.serverUrl, "http://mock.example");
  assert.equal(config.service.serverUrl, "http://service.example");
  assert.equal(config.experiment.podCount, 1);
  assert.equal(config.experiment.initialObservationsPerPod, 1);
  assert.equal(config.experiment.writeConcurrency, 100);
  assert.equal(config.experiment.resourceSampleIntervalMs, 250);
  assert.equal(config.experiment.repetitions, 5);
  assert.equal(config.experiment.retryCount, 1);
  assert.equal(config.experiment.observationsPerPodPerRound, 1);
  assert.equal(config.experiment.bootstrapIterations, 10_000);
  assert.equal(config.experiment.bootstrapConfidenceLevel, 0.95);
  assert.equal(config.experiment.bootstrapSeed, 20_261_012);
  assert.equal(config.experiment.requestTimeoutMs, 30_000);
  assert.equal(config.experiment.progressIntervalMs, 10_000);
});

test("rejects the former random observation range", () => {
  assert.throws(() => validateConfig({
    mock: { serverUrl: "http://mock.example" },
    service: { serverUrl: "http://service.example" },
    experiment: { minObservationsPerPod: 1, maxObservationsPerPod: 5 },
  }), /observationsPerPodPerRound/);
});

test("validates bootstrap configuration", () => {
  assert.throws(() => validateConfig({
    mock: { serverUrl: "http://mock.example" },
    service: { serverUrl: "http://service.example" },
    experiment: { bootstrapConfidenceLevel: 1 },
  }), /greater than 0 and less than 1/);
});
