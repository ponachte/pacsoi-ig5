import fs from "node:fs/promises";
import path from "node:path";
import { delay, errorDetails, expectResponse, fetchWithTimeout } from "../http.js";
import { monthBucket, observationTimestamp, tripleCount, WEIGHT_OBSERVATION_TRIPLES, weightValue } from "../mock/data.js";
import {
  DAY_TIMEOUT_MS,
  DISTRIBUTION_POLL_INTERVAL_MS,
  METRICS_POLL_INTERVAL_MS,
  PROGRESS_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from "../scenario.js";

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

async function fetchBody(url, operation, fetchImpl, options = {}) {
  return expectResponse(
    await fetchWithTimeout(fetchImpl, url, options, REQUEST_TIMEOUT_MS, operation),
    options.expectedStatus ?? 200,
    operation,
  );
}

async function fetchWeightSnapshot(serviceUrl, fetchImpl) {
  return weightSnapshot(await fetchBody(`${serviceUrl}/w-dist`, "Read weight distribution", fetchImpl, {
    headers: { Accept: "text/csv" },
  }));
}

const fetchMockMetrics = (mockUrl, fetchImpl) => fetchBody(`${mockUrl}/metrics`, "Read mock metrics", fetchImpl);

async function fetchServiceMetrics(serviceUrl, fetchImpl) {
  return { observedAt: new Date().toISOString(), ...await fetchBody(`${serviceUrl}/metrics`, "Read service metrics", fetchImpl) };
}

// Asks the mock to emit day `day` to every pod and returns its report.
export async function pushDay(mockUrl, day, fetchImpl = fetch) {
  return fetchBody(`${mockUrl}/admin/days/${day}`, `Push day ${day}`, fetchImpl, { method: "POST" });
}

// The service reports per-month means rounded to two decimals.
const AVERAGE_TOLERANCE = 0.011;

// Per-month totals of every observation the pods hold. The workload is
// deterministic, so the expected distribution follows from the generator.
export function createExpectation() {
  return { months: new Map(), count: 0, sum: 0 };
}

export function addDay(expected, podCount, day) {
  const month = monthBucket(observationTimestamp(day));
  const bucket = expected.months.get(month) ?? { count: 0, sum: 0 };
  for (let number = 1; number <= podCount; number += 1) {
    const value = weightValue(number, day);
    bucket.sum += value;
    expected.sum += value;
  }
  bucket.count += podCount;
  expected.count += podCount;
  expected.months.set(month, bucket);
  return expected;
}

export function expectedAverage(expected) {
  return expected.count ? expected.sum / expected.count : undefined;
}

// Describes the first month that differs between the service snapshot and the
// expected distribution, or returns undefined when every month matches.
export function distributionMismatch(snapshot, expected) {
  const rows = new Map(snapshot.rows.map((row) => [row.month, row]));
  for (const month of [...new Set([...rows.keys(), ...expected.months.keys()])].sort((a, b) => a - b)) {
    const row = rows.get(month);
    const bucket = expected.months.get(month);
    if (!bucket) return `month ${month}: unexpected row with count=${row.count}`;
    const average = bucket.sum / bucket.count;
    if (!row) return `month ${month}: missing, expected count=${bucket.count}, average=${average.toFixed(2)}`;
    if (row.count !== bucket.count || !(Math.abs(row.average - average) < AVERAGE_TOLERANCE)) {
      return `month ${month}: count=${row.count}, average=${row.average.toFixed(2)}; ` +
        `expected count=${bucket.count}, average=${average.toFixed(2)}`;
    }
  }
  return undefined;
}

// Polls /w-dist until every month matches. The returned poll timings bound the
// moment the service became correct: after the last failing poll started and
// before the successful poll completed.
export async function waitForAggregate(serviceUrl, expected, timeoutMs, fetchImpl = fetch, pollIntervalMs = DISTRIBUTION_POLL_INTERVAL_MS) {
  const started = performance.now();
  let latest;
  let mismatch;
  let polls = 0;
  let previousPollStartedMs;
  while (performance.now() - started < timeoutMs) {
    const pollStarted = performance.now();
    latest = await fetchWeightSnapshot(serviceUrl, fetchImpl);
    const pollCompleted = performance.now();
    polls += 1;
    mismatch = distributionMismatch(latest, expected);
    if (!mismatch) {
      return {
        aggregate: latest,
        polls,
        lastPollDurationMs: pollCompleted - pollStarted,
        previousPollStartedMs,
        completedMs: pollCompleted,
      };
    }
    previousPollStartedMs = pollStarted;
    await delay(pollIntervalMs);
  }
  throw Object.assign(new Error(
    `Timed out waiting for count=${expected.count}, average=${expectedAverage(expected)?.toFixed(2)}; ` +
    `latest count=${latest?.count ?? "unknown"}, average=${latest?.average?.toFixed(2) ?? "unknown"}` +
    `${mismatch ? `; first mismatch ${mismatch}` : ""}`,
  ), { code: "AGGREGATE_TIMEOUT", latestCount: latest?.count, firstMismatch: mismatch });
}

// Waits until the service's distribution is complete and correct. /metrics
// reports how many observations the distribution holds and is cheap, so it is
// polled often; every response is also kept as a resource sample. /w-dist
// sorts every stored value, so it is only requested once the count is
// complete, to confirm the content. The service became correct after the last
// incomplete /metrics poll started and before the confirming poll completed.
export async function waitForCompletion(serviceUrl, expected, timeoutMs, fetchImpl, samples, intervals = {}) {
  const started = performance.now();
  let previousPollStartedMs;
  let metricsPolls = 0;
  while (performance.now() - started < timeoutMs) {
    const pollStarted = performance.now();
    const metrics = await fetchServiceMetrics(serviceUrl, fetchImpl);
    const pollCompleted = performance.now();
    samples.push(metrics);
    metricsPolls += 1;
    if ((metrics.distribution?.observations ?? 0) >= expected.count) {
      const confirmation = await waitForAggregate(
        serviceUrl, expected, Math.max(1, timeoutMs - (pollCompleted - started)), fetchImpl, intervals.distributionMs,
      );
      const confirmedAtOnce = confirmation.polls === 1;
      return {
        aggregate: confirmation.aggregate,
        metricsPolls,
        distributionPolls: confirmation.polls,
        distributionRequestMs: confirmation.lastPollDurationMs,
        previousPollStartedMs: confirmedAtOnce ? previousPollStartedMs : confirmation.previousPollStartedMs,
        completedMs: confirmedAtOnce ? pollCompleted : confirmation.completedMs,
      };
    }
    previousPollStartedMs = pollStarted;
    await delay(intervals.metricsMs ?? METRICS_POLL_INTERVAL_MS);
  }
  const latestCount = samples.at(-1)?.distribution?.observations;
  throw Object.assign(
    new Error(`Timed out waiting for ${expected.count} observations; the service holds ${latestCount ?? "unknown"}`),
    { code: "AGGREGATE_TIMEOUT", latestCount },
  );
}

// The service opens one procedure and one weight subscription per pod. A day
// pushed before they are all open would be partly lost.
async function waitForSubscriptions(mockUrl, podCount, fetchImpl, pollIntervalMs = METRICS_POLL_INTERVAL_MS) {
  const started = performance.now();
  let metrics;
  while (performance.now() - started < STARTUP_TIMEOUT_MS) {
    metrics = await fetchMockMetrics(mockUrl, fetchImpl);
    if (metrics.subscriptions >= 2 * podCount) return metrics;
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${2 * podCount} subscriptions; mock has ${metrics?.subscriptions ?? "unknown"}`);
}

// The service resets its event-loop histogram on every /metrics call, so each
// sample covers the time since the previous one; the largest per-sample maximum
// is the worst delay of the whole period, independent of the sampling rate.
export function resourceSummary(samples, sinceProcessStart = false) {
  if (!samples.length) return { sampleCount: 0 };
  const first = samples[0].process;
  const last = samples.at(-1).process;
  const peaks = samples.reduce((summary, sample) => ({
    rssBytes: Math.max(summary.rssBytes, sample.process.maxRssBytes ?? sample.process.rss),
    heapUsedBytes: Math.max(summary.heapUsedBytes, sample.process.heapUsed),
    eventLoopMaxMs: Math.max(summary.eventLoopMaxMs, sample.eventLoop.maxMs),
  }), { rssBytes: 0, heapUsedBytes: 0, eventLoopMaxMs: 0 });
  return {
    peakRssBytes: peaks.rssBytes,
    peakHeapUsedBytes: peaks.heapUsedBytes,
    peakEventLoopDelayMs: peaks.eventLoopMaxMs,
    cpuUserMicros: sinceProcessStart ? last.cpuUserMicros : last.cpuUserMicros - first.cpuUserMicros,
    cpuSystemMicros: sinceProcessStart ? last.cpuSystemMicros : last.cpuSystemMicros - first.cpuSystemMicros,
    sampleCount: samples.length,
  };
}

// One simulated day: push one observation to every pod, then wait until the
// service returns the complete, correct distribution.
export async function runRound(config, round, expected, fetchImpl = fetch, intervals = {}) {
  const { podCount, days } = config.experiment;
  // Baseline for the CPU used during the day.
  const samples = [await fetchServiceMetrics(config.service.serverUrl, fetchImpl)];
  // t0: the day's push is requested; the mock emits its first event as soon
  // as the request arrives.
  const wallStartedAt = new Date().toISOString();
  const started = performance.now();
  let phase = "pushing";
  const progressTimer = setInterval(() => {
    console.log(
      `[round ${round}/${days}] phase=${phase} elapsed=${((performance.now() - started) / 1000).toFixed(1)}s ` +
      `serviceObservations=${samples.at(-1)?.distribution?.observations ?? "unknown"}/${expected.count}`,
    );
  }, PROGRESS_INTERVAL_MS);
  try {
    const push = await pushDay(config.mock.serverUrl, round, fetchImpl);
    const pushed = performance.now();
    if (push.events !== podCount) throw new Error(`Mock pushed ${push.events} events for day ${round}, expected ${podCount}`);
    addDay(expected, podCount, round);
    phase = "propagating";
    const completion = await waitForCompletion(config.service.serverUrl, expected, DAY_TIMEOUT_MS, fetchImpl, samples, intervals);
    const wallCorrectAt = new Date().toISOString();
    phase = "finalizing";
    const mockMetrics = await fetchMockMetrics(config.mock.serverUrl, fetchImpl);
    return {
      type: "round",
      round,
      podCount,
      observationsAdded: podCount,
      cumulativeObservations: expected.count,
      triplesAdded: podCount * WEIGHT_OBSERVATION_TRIPLES,
      cumulativeTriples: tripleCount(podCount, expected.count),
      expectedAverage: expectedAverage(expected),
      expectedMonths: expected.months.size,
      wallStartedAt,
      wallCorrectAt,
      pushMs: pushed - started,
      mockPushMs: push.pushMs,
      propagationMs: completion.completedMs - pushed,
      endToEndMs: completion.completedMs - started,
      // The service cannot be correct before the mock finished emitting the
      // day, nor before the last poll that still saw it incomplete.
      endToEndLowerBoundMs: Math.max(push.pushMs, (completion.previousPollStartedMs ?? started) - started),
      metricsPolls: completion.metricsPolls,
      distributionPolls: completion.distributionPolls,
      distributionRequestMs: completion.distributionRequestMs,
      resources: resourceSummary(samples),
      mockMemory: mockMetrics.memory,
      aggregate: completion.aggregate,
    };
  } catch (error) {
    error.lastServiceMetrics = samples.at(-1);
    error.roundProgress = { phase, elapsedMs: performance.now() - started };
    throw error;
  } finally {
    clearInterval(progressTimer);
  }
}

// Totals over all days of one run. yearWallMs runs from requesting day 1 to
// the moment the last day's distribution was observed to be correct.
export function yearSummary(rounds, repetition) {
  const sum = (field) => rounds.reduce((total, round) => total + round[field], 0);
  const first = rounds[0];
  const last = rounds.at(-1);
  return {
    type: "year",
    repetition,
    rounds: rounds.length,
    wallStartedAt: first?.wallStartedAt,
    wallCorrectAt: last?.wallCorrectAt,
    yearWallMs: first && last ? Date.parse(last.wallCorrectAt) - Date.parse(first.wallStartedAt) : 0,
    sumEndToEndMs: sum("endToEndMs"),
    sumPushMs: sum("pushMs"),
    sumPropagationMs: sum("propagationMs"),
    maxEndToEndMs: rounds.length ? Math.max(...rounds.map((round) => round.endToEndMs)) : undefined,
    finalObservations: last?.cumulativeObservations,
    finalTriples: last?.cumulativeTriples,
  };
}

function failureRecord(config, error, state, lastServiceMetrics, mockMetrics, repetition) {
  const observations = lastServiceMetrics?.distribution?.observations;
  const patients = lastServiceMetrics?.distribution?.patients;
  return {
    type: "failure",
    repetition,
    serviceVersion: config.service.version,
    failedAt: new Date().toISOString(),
    stage: state.stage,
    round: state.activeRound || undefined,
    ...(error.roundProgress ? { roundProgress: error.roundProgress } : {}),
    lastCompletedRound: state.lastCompletedRound,
    lastCompletedObservations: state.lastCompletedObservations,
    lastCompletedTriples: tripleCount(config.experiment.podCount, state.lastCompletedObservations),
    observationsAtFailure: mockMetrics?.observations,
    triplesAtFailure: mockMetrics?.triples,
    serviceMetricsObservedAt: lastServiceMetrics?.observedAt,
    serviceObservationsAtLastSample: observations,
    serviceTriplesAtLastSample: Number.isFinite(observations) && Number.isFinite(patients)
      ? tripleCount(patients, observations)
      : undefined,
    ...(lastServiceMetrics?.process ? {
      serviceMemoryAtLastSample: {
        rssBytes: lastServiceMetrics.process.rss,
        maxRssBytes: lastServiceMetrics.process.maxRssBytes,
        heapUsedBytes: lastServiceMetrics.process.heapUsed,
        heapTotalBytes: lastServiceMetrics.process.heapTotal,
      },
    } : {}),
    ...(error.code === "AGGREGATE_TIMEOUT" ? { serviceCountAtTimeout: error.latestCount, firstMismatch: error.firstMismatch } : {}),
    errorDetails: errorDetails(error),
    error: error.message,
  };
}

// Runs one repetition against an already started mock and service and writes
// a startup record, one record per day, and a year record to `output`.
export async function runExperiment(config, fetchImpl, { output, repetition, diagnosticFetchImpl, intervals = {} }) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, "");
  const { podCount, days } = config.experiment;
  const expected = addDay(createExpectation(), podCount, 0);
  const state = { stage: "startup", activeRound: 0, lastCompletedRound: 0, lastCompletedObservations: 0 };
  const rounds = [];
  const startupSamples = [];
  try {
    const startupStarted = performance.now();
    const initial = await waitForCompletion(config.service.serverUrl, expected, STARTUP_TIMEOUT_MS, fetchImpl, startupSamples, intervals);
    const initialCorrectMs = initial.completedMs - startupStarted;
    const startupMockMetrics = await waitForSubscriptions(config.mock.serverUrl, podCount, fetchImpl, intervals.metricsMs);
    startupSamples.push(await fetchServiceMetrics(config.service.serverUrl, fetchImpl));
    state.lastCompletedObservations = expected.count;
    await fs.appendFile(output, `${JSON.stringify({
      type: "startup",
      repetition,
      serviceVersion: config.service.version,
      podCount,
      days,
      writeConcurrency: config.experiment.writeConcurrency,
      initialObservations: expected.count,
      initialTriples: tripleCount(podCount, expected.count),
      expectedAverage: expectedAverage(expected),
      initialCorrectMs,
      benchmarkWaitMs: performance.now() - startupStarted,
      observedServiceUptimeMs: startupSamples.at(-1).uptimeSeconds * 1000,
      resources: resourceSummary(startupSamples, true),
      mockMemory: startupMockMetrics.memory,
      aggregate: initial.aggregate,
    })}\n`);

    state.stage = "round";
    for (let round = 1; round <= days; round += 1) {
      state.activeRound = round;
      const result = await runRound(config, round, expected, fetchImpl, intervals);
      await fs.appendFile(output, `${JSON.stringify(result)}\n`);
      rounds.push(result);
      state.lastCompletedRound = round;
      state.lastCompletedObservations = result.cumulativeObservations;
      console.log(
        `[${round}/${days}] total=${result.cumulativeObservations} push=${result.pushMs.toFixed(1)}ms ` +
        `propagation=${result.propagationMs.toFixed(1)}ms endToEnd=${result.endToEndMs.toFixed(1)}ms ` +
        `w-dist=${result.distributionRequestMs.toFixed(1)}ms rss=${(result.resources.peakRssBytes / 1024 / 1024).toFixed(1)}MiB`,
      );
    }
    await fs.appendFile(output, `${JSON.stringify(yearSummary(rounds, repetition))}\n`);
    return output;
  } catch (error) {
    let mockMetrics;
    if (error.processLabel !== "mock server") {
      try { mockMetrics = await fetchMockMetrics(config.mock.serverUrl, diagnosticFetchImpl ?? fetchImpl); } catch {}
    }
    const failure = failureRecord(
      config, error, state, error.lastServiceMetrics ?? startupSamples.at(-1), mockMetrics, repetition,
    );
    await fs.appendFile(output, `${JSON.stringify(failure)}\n`);
    error.benchmarkFailure = failure;
    error.runOutput = output;
    throw error;
  }
}
