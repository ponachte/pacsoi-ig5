// Read-query benchmark: replays the experiment's deterministic year into the
// service's WeightDistribution with both statistics strategies, in one
// process and without network or query engine, and measures how long the
// /w-dist computation (toCSV) takes at regular checkpoints. Both strategies
// receive identical data, so their CSV output must be identical as well.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "../config.js";
import { observationTimestamp, podId, PROCEDURE_AT, weightValue } from "../mock/data.js";

export const STRATEGIES = ["recompute", "incremental"];

export const DEFAULT_READ_BENCHMARK = { podCount: 10_000, days: 365, reads: 10, every: 30 };

// Both CSVs round to two decimals; a value that lies exactly on a rounding tie
// can round differently after floating-point error, so equal-within-rounding is
// a separate outcome from byte-identical.
const ROUNDING = 0.0100001;

export function withinRounding(difference) {
  return !difference.monthsDiffer && difference.count === 0
    && ["average", "stdev", "q25", "q75"].every((column) => difference[column] <= ROUNDING);
}

export function checkpoints(days, every) {
  const set = new Set([1, days]);
  for (let day = every; day < days; day += every) set.add(day);
  return [...set].sort((a, b) => a - b);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Largest absolute difference per CSV column between two /w-dist outputs.
export function csvDifference(a, b) {
  const rows = (csv) => new Map(csv.split("\n").slice(1).map((line) => {
    const [month, ...values] = line.split(",").map(Number);
    return [month, values];
  }));
  const left = rows(a);
  const right = rows(b);
  const columns = ["average", "stdev", "q25", "q75", "count"];
  const max = Object.fromEntries(columns.map((column) => [column, 0]));
  if (left.size !== right.size) return { ...max, monthsDiffer: true };
  for (const [month, values] of left) {
    const other = right.get(month);
    if (!other) return { ...max, monthsDiffer: true };
    columns.forEach((column, index) => {
      max[column] = Math.max(max[column], Math.abs(values[index] - other[index]));
    });
  }
  return max;
}

function timeReads(distribution, reads) {
  const durations = [];
  let csv;
  for (let read = 0; read < reads; read += 1) {
    const started = performance.now();
    csv = distribution.toCSV();
    durations.push(performance.now() - started);
  }
  return { csv, durations };
}

function host() {
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    gcExposed: typeof globalThis.gc === "function",
  };
}

export async function runReadBenchmark(options = {}, { output, log = console.log, distributionModule } = {}) {
  const { podCount, days, reads, every } = { ...DEFAULT_READ_BENCHMARK, ...options };
  const { WeightDistribution } = distributionModule
    ?? await import(pathToFileURL(path.join(projectRoot, "service", "dist", "distribution.js")).href);
  const startedAt = new Date().toISOString();
  const directory = output
    ?? path.join(projectRoot, "results", `read-benchmark-${startedAt.replace(/[:.]/g, "-")}`);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "read-benchmark.ndjson");
  const write = (record) => fs.appendFile(file, `${JSON.stringify(record)}\n`);

  await write({ type: "header", startedAt, podCount, days, reads, every, strategies: STRATEGIES, host: host() });
  const distributions = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, new WeightDistribution(strategy)]));
  const patients = Array.from({ length: podCount }, (_, index) => podId(index + 1, podCount));
  const procedure = new Date(PROCEDURE_AT);
  for (const distribution of Object.values(distributions)) {
    for (const patient of patients) distribution.addProcedure(patient, procedure);
  }

  const wanted = new Set(checkpoints(days, every));
  let identical = true;
  let agree = true;
  // Day 0 is the initial observation every pod holds before day 1.
  for (let day = 0; day <= days; day += 1) {
    const timestamp = new Date(observationTimestamp(day));
    const values = patients.map((_, index) => weightValue(index + 1, day));
    // Alternate the order so neither strategy systematically runs first.
    const order = day % 2 ? [...STRATEGIES].reverse() : STRATEGIES;
    const ingestMs = {};
    for (const strategy of order) {
      const distribution = distributions[strategy];
      const started = performance.now();
      for (let index = 0; index < podCount; index += 1) {
        distribution.addObservation(patients[index], values[index], timestamp);
      }
      ingestMs[strategy] = performance.now() - started;
    }
    if (!wanted.has(day)) continue;

    const record = { type: "checkpoint", day, observations: podCount * (day + 1), ingestMs, read: {} };
    const outputs = {};
    for (const strategy of order) {
      globalThis.gc?.();
      const { csv, durations } = timeReads(distributions[strategy], reads);
      outputs[strategy] = csv;
      record.read[strategy] = {
        medianMs: median(durations), minMs: Math.min(...durations), maxMs: Math.max(...durations), durations,
      };
    }
    record.identical = outputs.recompute === outputs.incremental;
    record.maxDifference = csvDifference(outputs.recompute, outputs.incremental);
    record.withinRounding = withinRounding(record.maxDifference);
    record.heapUsedBytes = process.memoryUsage().heapUsed;
    identical &&= record.identical;
    agree &&= record.withinRounding;
    await write(record);
    log(
      `[day ${day}/${days}] observations=${record.observations} ` +
      `recompute=${record.read.recompute.medianMs.toFixed(1)}ms ` +
      `incremental=${record.read.incremental.medianMs.toFixed(2)}ms identical=${record.identical}`,
    );
  }
  await write({
    type: "summary", completedAt: new Date().toISOString(), allIdentical: identical, allWithinRounding: agree,
  });
  return { output: file, allIdentical: identical, allWithinRounding: agree };
}
