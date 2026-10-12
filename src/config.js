import fs from "node:fs/promises";
import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "..");

function required(config, key, value) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing configuration value: ${key}`);
  return value.trim();
}

function positiveInteger(key, value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function nonNegativeInteger(key, value) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
  return value;
}

function probability(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${key} must be a number greater than 0 and less than 1`);
  }
  return value;
}

export function validateConfig(input) {
  const config = structuredClone(input);
  config.mock ??= {};
  config.service ??= {};
  config.experiment ??= {};

  config.mock.serverUrl = required(config, "mock.serverUrl", config.mock.serverUrl).replace(/\/$/, "");
  config.service.serverUrl = required(config, "service.serverUrl", config.service.serverUrl).replace(/\/$/, "");
  config.experiment.podPrefix = config.experiment.podPrefix || "latency";
  config.experiment.sliceName = config.experiment.sliceName || "pacsoi-latency";
  config.experiment.podCount = positiveInteger("experiment.podCount", config.experiment.podCount ?? 1);
  config.experiment.initialObservationsPerPod = positiveInteger(
    "experiment.initialObservationsPerPod",
    config.experiment.initialObservationsPerPod ?? 1,
  );
  config.experiment.iterations = positiveInteger("experiment.iterations", config.experiment.iterations ?? 5);
  config.experiment.repetitions = positiveInteger("experiment.repetitions", config.experiment.repetitions ?? 5);
  config.experiment.retryCount = nonNegativeInteger("experiment.retryCount", config.experiment.retryCount ?? 1);
  for (const legacyKey of ["minObservationsPerPod", "maxObservationsPerPod", "randomSeed"]) {
    if (legacyKey in config.experiment) {
      throw new Error(`experiment.${legacyKey} is no longer supported; use experiment.observationsPerPodPerRound`);
    }
  }
  config.experiment.observationsPerPodPerRound = positiveInteger(
    "experiment.observationsPerPodPerRound",
    config.experiment.observationsPerPodPerRound ?? 1,
  );
  config.experiment.bootstrapIterations = positiveInteger(
    "experiment.bootstrapIterations",
    config.experiment.bootstrapIterations ?? 10_000,
  );
  config.experiment.bootstrapConfidenceLevel = probability(
    "experiment.bootstrapConfidenceLevel",
    config.experiment.bootstrapConfidenceLevel ?? 0.95,
  );
  config.experiment.bootstrapSeed = nonNegativeInteger(
    "experiment.bootstrapSeed",
    config.experiment.bootstrapSeed ?? 20_261_012,
  );
  config.experiment.pollIntervalMs = positiveInteger("experiment.pollIntervalMs", config.experiment.pollIntervalMs ?? 100);
  config.experiment.timeoutMs = positiveInteger("experiment.timeoutMs", config.experiment.timeoutMs ?? 60_000);
  config.experiment.writeConcurrency = positiveInteger("experiment.writeConcurrency", config.experiment.writeConcurrency ?? 100);
  config.experiment.resourceSampleIntervalMs = positiveInteger(
    "experiment.resourceSampleIntervalMs",
    config.experiment.resourceSampleIntervalMs ?? 250,
  );
  config.experiment.startupTimeoutMs = positiveInteger(
    "experiment.startupTimeoutMs",
    config.experiment.startupTimeoutMs ?? config.experiment.timeoutMs,
  );
  config.experiment.shutdownTimeoutMs = positiveInteger(
    "experiment.shutdownTimeoutMs",
    config.experiment.shutdownTimeoutMs ?? 10_000,
  );
  return config;
}

export async function loadConfig(file = process.env.LATENCY_LAB_CONFIG || path.join(projectRoot, "config.json")) {
  try {
    return validateConfig(JSON.parse(await fs.readFile(path.resolve(file), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Configuration not found: ${path.resolve(file)}. Copy config.example.json to config.json.`);
    throw error;
  }
}
