import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.js";

test("an empty configuration runs the full one-year scenario", () => {
  assert.deepEqual(validateConfig({}), {
    mock: { serverUrl: "http://localhost:3001" },
    service: { serverUrl: "http://localhost:3000", version: "memory" },
    experiment: { podCount: 10_000, days: 365, repetitions: 50, writeConcurrency: 100 },
  });
});

test("accepts only scale, engine, repetitions, heap limit, and local URLs", () => {
  const config = validateConfig({
    mock: { serverUrl: "http://127.0.0.1:4001/" },
    service: { serverUrl: "http://localhost:4000", version: "level" },
    experiment: { podCount: 100, days: 40, repetitions: 2, writeConcurrency: 25, serviceMaxOldSpaceMiB: 4096 },
  });
  assert.equal(config.mock.serverUrl, "http://127.0.0.1:4001");
  assert.equal(config.service.version, "level");
  assert.deepEqual(config.experiment, {
    podCount: 100, days: 40, repetitions: 2, writeConcurrency: 25, serviceMaxOldSpaceMiB: 4096,
  });
});

test("rejects every other setting so runs cannot silently differ", () => {
  assert.throws(() => validateConfig({ experiment: { pollIntervalMs: 100 } }), /experiment.pollIntervalMs is not configurable/);
  assert.throws(() => validateConfig({ experiment: { iterations: 5 } }), /experiment.iterations is not configurable/);
  assert.throws(() => validateConfig({ mock: { podPrefix: "x" } }), /mock.podPrefix is not configurable/);
  assert.throws(() => validateConfig({ statistics: {} }), /Unknown configuration section: statistics/);
});

test("validates values", () => {
  assert.throws(() => validateConfig({ service: { version: "v3" } }), /service.version must be either memory or level/);
  assert.throws(() => validateConfig({ experiment: { days: 0 } }), /experiment.days must be a positive integer/);
  assert.throws(() => validateConfig({ experiment: { writeConcurrency: 0 } }), /experiment.writeConcurrency must be a positive integer/);
  assert.throws(() => validateConfig({ experiment: { serviceMaxOldSpaceMiB: 1.5 } }), /serviceMaxOldSpaceMiB/);
  assert.throws(() => validateConfig({ mock: { serverUrl: "http://pods.example:3001" } }), /local http URL/);
  assert.throws(() => validateConfig({ service: { serverUrl: "http://localhost" } }), /with a port/);
});
