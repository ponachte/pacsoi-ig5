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
});
