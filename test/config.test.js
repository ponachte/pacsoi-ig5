import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";

test("configuration contains only the required external connection values", () => {
  const config = validateConfig({
    kvasir: { serverUrl: "https://kvasir.example/", clientId: "client", clientSecret: "secret" },
    aggregator: { serverUrl: "https://aggregator.example/", deploymentFunction: "probe", serviceName: "test" },
    experiment: {},
  });
  assert.equal(config.kvasir.serverUrl, "https://kvasir.example");
  assert.equal(config.aggregator.serverUrl, "https://aggregator.example");
  assert.equal(config.experiment.podCount, 1);
  assert.equal(config.experiment.podPrefix, "latency");
  assert.equal(config.experiment.minObservationsPerPod, 1);
  assert.equal(config.experiment.maxObservationsPerPod, 5);
});
