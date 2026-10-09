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
  config.experiment.minObservationsPerPod = positiveInteger("experiment.minObservationsPerPod", config.experiment.minObservationsPerPod ?? 1);
  config.experiment.maxObservationsPerPod = positiveInteger("experiment.maxObservationsPerPod", config.experiment.maxObservationsPerPod ?? 5);
  if (config.experiment.minObservationsPerPod > config.experiment.maxObservationsPerPod) {
    throw new Error("experiment.minObservationsPerPod cannot exceed experiment.maxObservationsPerPod");
  }
  config.experiment.pollIntervalMs = positiveInteger("experiment.pollIntervalMs", config.experiment.pollIntervalMs ?? 100);
  config.experiment.timeoutMs = positiveInteger("experiment.timeoutMs", config.experiment.timeoutMs ?? 60_000);
  config.experiment.writeConcurrency = positiveInteger("experiment.writeConcurrency", config.experiment.writeConcurrency ?? 100);
  config.experiment.resourceSampleIntervalMs = positiveInteger(
    "experiment.resourceSampleIntervalMs",
    config.experiment.resourceSampleIntervalMs ?? 250,
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
