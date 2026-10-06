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
  config.kvasir ??= {};
  config.aggregator ??= {};
  config.experiment ??= {};

  config.kvasir.serverUrl = required(config, "kvasir.serverUrl", config.kvasir.serverUrl).replace(/\/$/, "");
  config.kvasir.clientId = required(config, "kvasir.clientId", config.kvasir.clientId);
  config.kvasir.clientSecret = required(config, "kvasir.clientSecret", config.kvasir.clientSecret);
  config.aggregator.serverUrl = required(config, "aggregator.serverUrl", config.aggregator.serverUrl).replace(/\/$/, "");
  config.aggregator.deploymentFunction = required(config, "aggregator.deploymentFunction", config.aggregator.deploymentFunction);
  config.aggregator.serviceName = required(config, "aggregator.serviceName", config.aggregator.serviceName);
  config.aggregator.sourceParameter = config.aggregator.sourceParameter || "sources";
  config.aggregator.weightPath = (config.aggregator.weightPath || "w-dist").replace(/^\/+|\/+$/g, "");
  config.experiment.podPrefix = config.experiment.podPrefix || "latency";
  config.experiment.sliceName = config.experiment.sliceName || "pacsoi-latency";
  config.experiment.podCount = positiveInteger("experiment.podCount", config.experiment.podCount ?? 1);
  config.experiment.iterations = positiveInteger("experiment.iterations", config.experiment.iterations ?? 5);
  config.experiment.minObservationsPerPod = positiveInteger("experiment.minObservationsPerPod", config.experiment.minObservationsPerPod ?? 1);
  config.experiment.maxObservationsPerPod = positiveInteger("experiment.maxObservationsPerPod", config.experiment.maxObservationsPerPod ?? 5);
  if (config.experiment.minObservationsPerPod > config.experiment.maxObservationsPerPod) {
    throw new Error("experiment.minObservationsPerPod cannot exceed experiment.maxObservationsPerPod");
  }
  config.experiment.pollIntervalMs = positiveInteger("experiment.pollIntervalMs", config.experiment.pollIntervalMs ?? 100);
  config.experiment.timeoutMs = positiveInteger("experiment.timeoutMs", config.experiment.timeoutMs ?? 60_000);
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
