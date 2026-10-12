import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../config.js";
import { delay, expectResponse } from "../http.js";
import { initialValues, writeObservationRound } from "../mock/client.js";
import { tripleCount, WEIGHT_OBSERVATION_TRIPLES } from "../mock/data.js";

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

async function fetchMockMetrics(mockUrl, fetchImpl = fetch) {
  return expectResponse(await fetchImpl(`${mockUrl}/metrics`), 200, "Read mock metrics");
}

function verifyTripleCount(metrics, expected) {
  if (metrics.triples !== expected) {
    throw new Error(`Mock reports ${metrics.triples} triples, expected ${expected}`);
  }
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
  const errors = [];
  let inFlight;
  const capture = async () => {
    const response = await fetchImpl(`${serviceUrl}/metrics`);
    const metrics = await expectResponse(response, 200, "Read service metrics");
    samples.push({ observedAt: new Date().toISOString(), ...metrics });
  };
  await capture();
  const timer = setInterval(() => {
    if (!inFlight) {
      inFlight = capture()
        .catch((error) => { errors.push({ observedAt: new Date().toISOString(), message: error.message }); })
        .finally(() => { inFlight = undefined; });
    }
  }, intervalMs);
  return async () => {
    clearInterval(timer);
    if (inFlight) await inFlight;
    try { await capture(); } catch (error) {
      errors.push({ observedAt: new Date().toISOString(), message: error.message });
    }
    if (errors.length) samples.samplingErrors = errors;
    return samples;
  };
}

async function stopSamplerSafely(stopSampling) {
  if (!stopSampling) return [];
  try { return await stopSampling(); } catch { return []; }
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
    ...(samples.samplingErrors?.length ? { samplingErrors: samples.samplingErrors } : {}),
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
    const mockMetrics = await fetchMockMetrics(config.mock.serverUrl, fetchImpl);
    const cumulativeTriples = tripleCount(config.experiment.podCount, expected.count);
    verifyTripleCount(mockMetrics, cumulativeTriples);
    return {
      type: "round",
      round,
      podCount: writes.length,
      observationsAdded: roundValues.length,
      cumulativeObservations: expected.count,
      triplesAdded: roundValues.length * WEIGHT_OBSERVATION_TRIPLES,
      cumulativeTriples,
      expectedAverage: expected.average,
      wallStartedAt,
      wallCompletedAt: new Date().toISOString(),
      writePhaseMs: lastWriteAccepted - started,
      propagationAfterLastWriteMs: completed - lastWriteAccepted,
      endToEndMs: completed - started,
      resources: resourceSummary(samples),
      mockMetrics,
      writes,
      aggregate,
    };
  } catch (error) {
    const samples = await stopSamplerSafely(stopSampling);
    error.lastServiceMetrics = samples.at(-1);
    throw error;
  }
}

export async function runExperiment(config, fetchImpl = fetch, options = {}) {
  const suffix = options.name ? `-${options.name}` : "";
  const output = options.output ?? path.join(projectRoot, "results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}${suffix}.ndjson`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, "");
  const cumulativeValues = initialValues(config);
  const initialExpected = expectation(cumulativeValues);
  let stage = "startup";
  let activeRound = 0;
  let lastCompletedRound = 0;
  let lastCompletedObservations = 0;
  let lastCompletedTriples = 0;
  let startupStopSampling;
  try {
    const startupStarted = performance.now();
    startupStopSampling = await resourceSampler(config.service.serverUrl, config.experiment.resourceSampleIntervalMs, fetchImpl);
    const initialAggregate = await waitForAggregate(config.service.serverUrl, initialExpected, config.experiment, fetchImpl);
    const startupSamples = await startupStopSampling();
    startupStopSampling = undefined;
    const startupMockMetrics = await fetchMockMetrics(config.mock.serverUrl, fetchImpl);
    const initialTriples = tripleCount(config.experiment.podCount, initialExpected.count);
    verifyTripleCount(startupMockMetrics, initialTriples);
    lastCompletedObservations = initialExpected.count;
    lastCompletedTriples = initialTriples;
    await fs.appendFile(output, `${JSON.stringify({
      type: "startup",
      repetition: options.repetition,
      podCount: config.experiment.podCount,
      initialObservations: initialExpected.count,
      initialTriples,
      expectedAverage: initialExpected.average,
      benchmarkWaitMs: performance.now() - startupStarted,
      observedServiceUptimeMs: startupSamples.at(-1).uptimeSeconds * 1000,
      resources: resourceSummary(startupSamples, true),
      mockMetrics: startupMockMetrics,
      aggregate: initialAggregate,
    })}\n`);

    stage = "round";
    for (let round = 1; round <= config.experiment.iterations; round += 1) {
      activeRound = round;
      const result = await runRound(config, round, cumulativeValues, fetchImpl);
      await fs.appendFile(output, `${JSON.stringify(result)}\n`);
      lastCompletedRound = round;
      lastCompletedObservations = result.cumulativeObservations;
      lastCompletedTriples = result.cumulativeTriples;
      console.log(
        `[${round}/${config.experiment.iterations}] added=${result.observationsAdded} ` +
        `total=${result.cumulativeObservations} write=${result.writePhaseMs.toFixed(1)}ms ` +
        `propagation=${result.propagationAfterLastWriteMs.toFixed(1)}ms ` +
        `rss=${(result.resources.peakRssBytes / 1024 / 1024).toFixed(1)}MiB`,
      );
    }
    return output;
  } catch (error) {
    const startupFailureSamples = await stopSamplerSafely(startupStopSampling);
    const lastServiceMetrics = error.lastServiceMetrics ?? startupFailureSamples.at(-1);
    let mockMetrics;
    try { mockMetrics = await fetchMockMetrics(config.mock.serverUrl, fetchImpl); } catch {}
    const serviceObservationsAtLastSample = lastServiceMetrics?.distribution?.observations;
    const servicePatientsAtLastSample = lastServiceMetrics?.distribution?.patients;
    const failure = {
      type: "failure",
      repetition: options.repetition,
      failedAt: new Date().toISOString(),
      stage,
      round: activeRound || undefined,
      lastCompletedRound,
      lastCompletedObservations,
      lastCompletedTriples,
      observationsAtFailure: mockMetrics?.observations,
      triplesAtFailure: mockMetrics?.triples,
      serviceMetricsObservedAt: lastServiceMetrics?.observedAt ?? lastServiceMetrics?.timestamp,
      serviceObservationsAtLastSample,
      serviceTriplesAtLastSample: Number.isFinite(serviceObservationsAtLastSample) && Number.isFinite(servicePatientsAtLastSample)
        ? tripleCount(servicePatientsAtLastSample, serviceObservationsAtLastSample)
        : undefined,
      mockMetrics,
      error: error.message,
    };
    await fs.appendFile(output, `${JSON.stringify(failure)}\n`);
    error.benchmarkFailure = failure;
    error.runOutput = output;
    throw error;
  }
}
