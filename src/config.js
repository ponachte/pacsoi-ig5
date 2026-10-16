import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_DAYS, DEFAULT_POD_COUNT, DEFAULT_REPETITIONS, DEFAULT_WRITE_CONCURRENCY } from "./scenario.js";

export const projectRoot = path.resolve(import.meta.dirname, "..");

const SECTIONS = {
  mock: ["serverUrl"],
  service: ["serverUrl", "version", "distribution"],
  experiment: ["podCount", "days", "repetitions", "writeConcurrency", "serviceMaxOldSpaceMiB"],
};

function positiveInteger(key, value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function localUrl(key, value) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(hostname) || !url.port) {
    throw new Error(`${key} must be a local http URL with a port, received ${value}`);
  }
  return value.replace(/\/$/, "");
}

// Rejects every key outside the configurable surface, so a run can never be
// silently shaped by an obsolete or misspelled setting.
export function validateConfig(input = {}) {
  for (const key of Object.keys(input)) {
    if (!(key in SECTIONS)) throw new Error(`Unknown configuration section: ${key}`);
  }
  for (const [section, keys] of Object.entries(SECTIONS)) {
    for (const key of Object.keys(input[section] ?? {})) {
      if (!keys.includes(key)) throw new Error(`${section}.${key} is not configurable`);
    }
  }
  const version = input.service?.version ?? "memory";
  if (!["memory", "level"].includes(version)) throw new Error("service.version must be either memory or level");
  const distribution = input.service?.distribution ?? "recompute";
  if (!["recompute", "incremental"].includes(distribution)) {
    throw new Error("service.distribution must be either recompute or incremental");
  }
  const experiment = input.experiment ?? {};
  return {
    mock: { serverUrl: localUrl("mock.serverUrl", input.mock?.serverUrl ?? "http://localhost:3001") },
    service: {
      serverUrl: localUrl("service.serverUrl", input.service?.serverUrl ?? "http://localhost:3000"),
      version,
      distribution,
    },
    experiment: {
      podCount: positiveInteger("experiment.podCount", experiment.podCount ?? DEFAULT_POD_COUNT),
      days: positiveInteger("experiment.days", experiment.days ?? DEFAULT_DAYS),
      repetitions: positiveInteger("experiment.repetitions", experiment.repetitions ?? DEFAULT_REPETITIONS),
      writeConcurrency: positiveInteger(
        "experiment.writeConcurrency",
        experiment.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY,
      ),
      ...(experiment.serviceMaxOldSpaceMiB === undefined ? {} : {
        serviceMaxOldSpaceMiB: positiveInteger("experiment.serviceMaxOldSpaceMiB", experiment.serviceMaxOldSpaceMiB),
      }),
    },
  };
}

// config.json is optional: without it the default scenario runs.
export async function loadConfig(file = process.env.LATENCY_LAB_CONFIG || path.join(projectRoot, "config.json")) {
  let input = {};
  try {
    input = JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || process.env.LATENCY_LAB_CONFIG) throw error;
  }
  return validateConfig(input);
}
