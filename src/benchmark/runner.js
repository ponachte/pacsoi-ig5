import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../config.js";
import { delay, expectResponse } from "../http.js";
import { readState } from "../state.js";
import { writeObservationRound } from "../kvasir/slices.js";

export function parseWeightCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines[0] !== "month,avg_weight,stdev,q25,q75,count") {
    throw new Error(`Unexpected PACSOI weight CSV header: ${lines[0] || "<empty>"}`);
  }
  return lines.slice(1).map((line) => {
    const [month, average, stdev, q25, q75, count] = line.split(",").map(Number);
    return { month, average, stdev, q25, q75, count };
  });
}

export function weightSnapshot(csv) {
  const rows = parseWeightCsv(csv);
  const count = rows.reduce((total, row) => total + row.count, 0);
  const weightedSum = rows.reduce((total, row) => total + row.average * row.count, 0);
  return { rows, count, average: count ? weightedSum / count : undefined };
}

async function fetchWeightSnapshot(weightUrl, fetchImpl = fetch) {
  const response = await fetchImpl(weightUrl, { headers: { Accept: "text/csv" } });
  const csv = await expectResponse(response, 200, "Read PACSOI weight distribution");
  return weightSnapshot(csv);
}

export async function waitForAggregate(weightUrl, expected, settings, fetchImpl = fetch) {
  const started = performance.now();
  let latest;
  while (performance.now() - started < settings.timeoutMs) {
    latest = await fetchWeightSnapshot(weightUrl, fetchImpl);
    const averageMatches = latest.average !== undefined && Math.abs(latest.average - expected.average) < 0.011;
    if (latest.count === expected.count && averageMatches) return latest;
    await delay(settings.pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for PACSOI aggregate count=${expected.count}, average=${expected.average.toFixed(2)}; ` +
    `latest count=${latest?.count ?? "unknown"}, average=${latest?.average?.toFixed(2) ?? "unknown"}`,
  );
}

export async function waitForEmptyStartup(weightUrl, settings, fetchImpl = fetch) {
  const started = performance.now();
  while (performance.now() - started < settings.timeoutMs) {
    try {
      const snapshot = await fetchWeightSnapshot(weightUrl, fetchImpl);
      if (snapshot.count !== 0) {
        throw new Error(`PACSOI service is not empty at startup; it already contains ${snapshot.count} observations`);
      }
      return snapshot;
    } catch (error) {
      if (error.message.includes("not empty")) throw error;
      await delay(settings.pollIntervalMs);
    }
  }
  throw new Error(`PACSOI weight distribution did not become ready within ${settings.timeoutMs}ms`);
}

export async function runRound(config, weightUrl, round, cumulativeValues, fetchImpl = fetch) {
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();
  const writes = await writeObservationRound(config, round, fetchImpl);
  const lastWriteAccepted = performance.now();
  const roundValues = writes.flatMap(({ values }) => values);
  cumulativeValues.push(...roundValues);
  const expected = {
    count: cumulativeValues.length,
    average: cumulativeValues.reduce((sum, value) => sum + value, 0) / cumulativeValues.length,
  };
  const aggregate = await waitForAggregate(weightUrl, expected, config.experiment, fetchImpl);
  const completed = performance.now();
  return {
    round,
    podCount: writes.length,
    observationsAdded: roundValues.length,
    cumulativeObservations: expected.count,
    expectedAverage: expected.average,
    wallStartedAt,
    wallCompletedAt: new Date().toISOString(),
    endToEndMs: completed - started,
    propagationMs: completed - lastWriteAccepted,
    writes: writes.map(({ values, ...write }) => ({ ...write, values })),
    aggregate,
  };
}

export async function runExperiment(config, fetchImpl = fetch) {
  const state = await readState("aggregator.json");
  if (!state?.weightUrl) throw new Error("No deployed PACSOI service state. Run `latency-lab service deploy` first.");
  await waitForEmptyStartup(state.weightUrl, config.experiment, fetchImpl);

  const output = path.join(projectRoot, "results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const cumulativeValues = [];
  for (let round = 1; round <= config.experiment.iterations; round += 1) {
    const result = await runRound(config, state.weightUrl, round, cumulativeValues, fetchImpl);
    await fs.appendFile(output, `${JSON.stringify(result)}\n`);
    console.log(
      `[${round}/${config.experiment.iterations}] added=${result.observationsAdded} ` +
      `total=${result.cumulativeObservations} propagation=${result.propagationMs.toFixed(1)}ms ` +
      `end-to-end=${result.endToEndMs.toFixed(1)}ms`,
    );
  }
  return output;
}
