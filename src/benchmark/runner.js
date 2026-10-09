import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../config.js";
import { delay, expectResponse } from "../http.js";
import { initialValues, writeObservationRound } from "../mock/client.js";

export function parseWeightCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length || lines[0] !== "month,avg_weight,stdev,q25,q75,count") {
    throw new Error(`Unexpected weight CSV header: ${lines[0] || "<empty>"}`);
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

async function fetchWeightSnapshot(serviceUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${serviceUrl}/w-dist`, { headers: { Accept: "text/csv" } });
  const csv = await expectResponse(response, 200, "Read weight distribution");
  return weightSnapshot(csv);
}

export async function waitForAggregate(serviceUrl, expected, settings, fetchImpl = fetch) {
  const started = performance.now();
  let latest;
  while (performance.now() - started < settings.timeoutMs) {
    latest = await fetchWeightSnapshot(serviceUrl, fetchImpl);
    const averageMatches = latest.average !== undefined && Math.abs(latest.average - expected.average) < 0.011;
    if (latest.count === expected.count && averageMatches) return latest;
    await delay(settings.pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for count=${expected.count}, average=${expected.average.toFixed(2)}; ` +
    `latest count=${latest?.count ?? "unknown"}, average=${latest?.average?.toFixed(2) ?? "unknown"}`,
  );
}

async function resourceSampler(serviceUrl, intervalMs, fetchImpl) {
  const samples = [];
  let inFlight;
  const capture = async () => {
    const response = await fetchImpl(`${serviceUrl}/metrics`);
    const metrics = await expectResponse(response, 200, "Read service metrics");
    samples.push({ observedAt: new Date().toISOString(), ...metrics });
  };
  await capture();
  const timer = setInterval(() => {
    if (!inFlight) inFlight = capture().finally(() => { inFlight = undefined; });
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
    await capture();
    return samples;
  };
}

export function resourceSummary(samples, sinceProcessStart = false) {
  if (!samples.length) return { samples: [] };
  const first = samples[0].process;
  const last = samples.at(-1).process;
  return {
    peakRssBytes: Math.max(...samples.map((sample) => sample.process.maxRssBytes ?? sample.process.rss)),
    peakHeapUsedBytes: Math.max(...samples.map((sample) => sample.process.heapUsed)),
    peakEventLoopP95Ms: Math.max(...samples.map((sample) => sample.eventLoop.p95Ms)),
    cpuUserMicros: sinceProcessStart ? last.cpuUserMicros : last.cpuUserMicros - first.cpuUserMicros,
    cpuSystemMicros: sinceProcessStart ? last.cpuSystemMicros : last.cpuSystemMicros - first.cpuSystemMicros,
    samples,
  };
}

function expectation(values) {
  return {
    count: values.length,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

export async function runRound(config, round, cumulativeValues, fetchImpl = fetch) {
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();
  const stopSampling = await resourceSampler(
    config.service.serverUrl,
    config.experiment.resourceSampleIntervalMs,
    fetchImpl,
  );
  try {
    const writes = await writeObservationRound(config, round, fetchImpl);
    const lastWriteAccepted = performance.now();
    const roundValues = writes.flatMap(({ values }) => values);
    cumulativeValues.push(...roundValues);
    const expected = expectation(cumulativeValues);
    const aggregate = await waitForAggregate(config.service.serverUrl, expected, config.experiment, fetchImpl);
    const completed = performance.now();
    const samples = await stopSampling();
    return {
      type: "round",
      round,
      podCount: writes.length,
      observationsAdded: roundValues.length,
      cumulativeObservations: expected.count,
      expectedAverage: expected.average,
      wallStartedAt,
      wallCompletedAt: new Date().toISOString(),
      writePhaseMs: lastWriteAccepted - started,
      propagationAfterLastWriteMs: completed - lastWriteAccepted,
      endToEndMs: completed - started,
      resources: resourceSummary(samples),
      writes,
      aggregate,
    };
  } catch (error) {
    await stopSampling();
    throw error;
  }
}

export async function runExperiment(config, fetchImpl = fetch) {
  const output = path.join(projectRoot, "results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const cumulativeValues = initialValues(config);
  const initialExpected = expectation(cumulativeValues);
  const startupStarted = performance.now();
  const stopSampling = await resourceSampler(config.service.serverUrl, config.experiment.resourceSampleIntervalMs, fetchImpl);
  const initialAggregate = await waitForAggregate(config.service.serverUrl, initialExpected, config.experiment, fetchImpl);
  const startupSamples = await stopSampling();
  await fs.appendFile(output, `${JSON.stringify({
    type: "startup",
    podCount: config.experiment.podCount,
    initialObservations: initialExpected.count,
    expectedAverage: initialExpected.average,
    benchmarkWaitMs: performance.now() - startupStarted,
    observedServiceUptimeMs: startupSamples.at(-1).uptimeSeconds * 1000,
    resources: resourceSummary(startupSamples, true),
    aggregate: initialAggregate,
  })}\n`);

  for (let round = 1; round <= config.experiment.iterations; round += 1) {
    const result = await runRound(config, round, cumulativeValues, fetchImpl);
    await fs.appendFile(output, `${JSON.stringify(result)}\n`);
    console.log(
      `[${round}/${config.experiment.iterations}] added=${result.observationsAdded} ` +
      `total=${result.cumulativeObservations} write=${result.writePhaseMs.toFixed(1)}ms ` +
      `propagation=${result.propagationAfterLastWriteMs.toFixed(1)}ms ` +
      `rss=${(result.resources.peakRssBytes / 1024 / 1024).toFixed(1)}MiB`,
    );
  }
  return output;
}
