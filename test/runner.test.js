import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addDay,
  createExpectation,
  distributionMismatch,
  parseWeightCsv,
  resourceSummary,
  runExperiment,
  runRound,
  waitForAggregate,
  waitForCompletion,
  weightSnapshot,
  yearSummary,
} from "../src/benchmark/runner.js";
import { weightValue } from "../src/mock/data.js";

const HEADER = "month,avg_weight,stdev,q25,q75,count";

function csvFor(expected) {
  return [HEADER, ...[...expected.months].sort(([a], [b]) => a - b).map(([month, { count, sum }]) =>
    `${month},${(sum / count).toFixed(2)},0.00,0.00,0.00,${count}`)].join("\n");
}

const metrics = (observations = 0) => ({
  uptimeSeconds: 1,
  process: { rss: 100, maxRssBytes: 100, heapUsed: 50, heapTotal: 60, cpuUserMicros: 1, cpuSystemMicros: 1 },
  eventLoop: { maxMs: 1 },
  distribution: { observations },
});
const fast = { metricsMs: 1, distributionMs: 1 };

test("PACSOI weight CSV is parsed into a cumulative completion snapshot", () => {
  const csv = `${HEADER}\n1,82.50,0.50,82.25,82.75,2`;
  assert.deepEqual(parseWeightCsv(csv), [{ month: 1, average: 82.5, stdev: 0.5, q25: 82.25, q75: 82.75, count: 2 }]);
  assert.deepEqual(weightSnapshot(csv), {
    rows: [{ month: 1, average: 82.5, stdev: 0.5, q25: 82.25, q75: 82.75, count: 2 }],
    count: 2,
    average: 82.5,
  });
  assert.deepEqual(weightSnapshot(HEADER), { rows: [], count: 0, average: undefined });
});

test("the expected distribution follows from the generator, one day at a time", () => {
  const expected = addDay(addDay(createExpectation(), 2, 0), 2, 17);
  assert.equal(expected.count, 4);
  assert.deepEqual([...expected.months.keys()], [0, 1]);
  assert.equal(expected.months.get(1).count, 2);
  assert.equal(expected.months.get(1).sum, weightValue(1, 17) + weightValue(2, 17));
});

test("a distribution with the right total but the wrong month split is not correct", () => {
  const expected = addDay(addDay(createExpectation(), 1, 0), 1, 17);
  assert.equal(distributionMismatch(weightSnapshot(csvFor(expected)), expected), undefined);
  const [day0, day17] = [weightValue(1, 0), weightValue(1, 17)];
  const merged = weightSnapshot(`${HEADER}\n0,${((day0 + day17) / 2).toFixed(2)},0,0,0,2`);
  assert.equal(merged.count, expected.count);
  assert.match(distributionMismatch(merged, expected), /^month 0: count=2/);
  assert.match(distributionMismatch(weightSnapshot(`${HEADER}\n0,${day0},0,0,0,1`), expected), /^month 1: missing/);
  assert.match(distributionMismatch(weightSnapshot(`${csvFor(expected)}\n2,1.00,0,0,0,1`), expected), /^month 2: unexpected/);
});

test("waitForAggregate reports poll timings that bound the completion moment", async () => {
  const expected = addDay(createExpectation(), 1, 0);
  const responses = [HEADER, csvFor(expected)];
  const result = await waitForAggregate("http://service", expected, 1000,
    async () => new Response(responses.shift(), { status: 200 }), 1);
  assert.equal(result.polls, 2);
  assert.equal(result.aggregate.count, 1);
  assert.ok(result.completedMs >= result.previousPollStartedMs);
  assert.ok(result.lastPollDurationMs >= 0);
});

test("completion is detected from the cheap observation count and confirmed once by /w-dist", async () => {
  const expected = addDay(createExpectation(), 2, 0);
  const counts = [0, 1, 2];
  let distributionRequests = 0;
  const samples = [];
  const result = await waitForCompletion("http://service", expected, 1000, async (url) => {
    if (url === "http://service/metrics") return Response.json(metrics(counts.shift()));
    distributionRequests += 1;
    return new Response(csvFor(expected), { status: 200 });
  }, samples, fast);
  assert.equal(result.metricsPolls, 3);
  assert.equal(distributionRequests, 1);
  assert.equal(result.distributionPolls, 1);
  assert.equal(samples.length, 3);
  assert.ok(result.completedMs >= result.previousPollStartedMs);
});

test("a complete count with wrong content is not accepted", async () => {
  const expected = addDay(createExpectation(), 1, 0);
  await assert.rejects(
    waitForCompletion("http://service", expected, 30, async (url) => (url === "http://service/metrics"
      ? Response.json(metrics(1))
      : new Response(`${HEADER}\n0,1.00,0,0,0,1`, { status: 200 })), [], fast),
    (error) => error.code === "AGGREGATE_TIMEOUT" && /first mismatch month 0/.test(error.message),
  );
  await assert.rejects(
    waitForCompletion("http://service", expected, 20, async () => Response.json(metrics(0)), [], fast),
    (error) => error.code === "AGGREGATE_TIMEOUT" && /holds 0/.test(error.message),
  );
});

test("waitForAggregate marks a service that never becomes correct", async () => {
  const expected = addDay(createExpectation(), 1, 0);
  await assert.rejects(
    waitForAggregate("http://service", expected, 20, async () => new Response(HEADER, { status: 200 }), 1),
    (error) => error.code === "AGGREGATE_TIMEOUT" && /first mismatch month 0: missing/.test(error.message),
  );
});

function fakeLab(podCount, expected, events) {
  return async (url, options = {}) => {
    if (url === "http://service/metrics") return Response.json(metrics(expected.count));
    if (url === "http://service/w-dist") return new Response(csvFor(expected), { status: 200 });
    if (url === "http://mock/metrics") return Response.json({ subscriptions: 2 * podCount, memory: { rss: 1 } });
    const day = url.match(/^http:\/\/mock\/admin\/days\/(\d+)$/)?.[1];
    if (day && options.method === "POST") {
      events.push(Number(day));
      return Response.json({ day: Number(day), events: podCount, pushMs: 0.01 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

const config = (podCount, days) => ({
  mock: { serverUrl: "http://mock" },
  service: { serverUrl: "http://service", version: "memory" },
  experiment: { podCount, days, repetitions: 1 },
});

test("a day is pushed once, checked against the generator, and timed from the push", async () => {
  const expected = addDay(createExpectation(), 2, 0);
  const pushed = [];
  const result = await runRound(config(2, 20), 20, expected, fakeLab(2, expected, pushed), fast);

  assert.deepEqual(pushed, [20]);
  assert.equal(result.observationsAdded, 2);
  assert.equal(result.cumulativeObservations, 4);
  assert.equal(result.expectedMonths, 2);
  assert.deepEqual(result.aggregate.rows.map(({ month, count }) => [month, count]), [[0, 2], [1, 2]]);
  assert.equal(result.mockPushMs, 0.01);
  assert.ok(result.endToEndMs >= result.pushMs);
  assert.ok(result.endToEndMs >= result.endToEndLowerBoundMs);
  assert.ok(result.endToEndLowerBoundMs >= 0.01);
  assert.equal(result.metricsPolls, 1);
  assert.equal(result.distributionPolls, 1);
  assert.equal(result.resources.sampleCount, 2);
  assert.equal(result.resources.peakEventLoopDelayMs, 1);
});

test("a run writes startup, one record per day, and a year record", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-run-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "run.ndjson");
  const expected = createExpectation();
  const pushed = [];
  const tracked = fakeLab(3, expected, pushed);
  // The fake service is always exactly correct for the days pushed so far.
  const truth = () => {
    const state = createExpectation();
    for (let day = 0; day <= pushed.length; day += 1) addDay(state, 3, day);
    return state;
  };
  const fetchImpl = async (url, options) => {
    if (url === "http://service/w-dist") return new Response(csvFor(truth()), { status: 200 });
    if (url === "http://service/metrics") return Response.json(metrics(truth().count));
    return tracked(url, options);
  };

  await runExperiment(config(3, 4), fetchImpl, { output, repetition: 1, intervals: fast });
  const records = (await fs.readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ type }) => type), ["startup", "round", "round", "round", "round", "year"]);
  assert.deepEqual(pushed, [1, 2, 3, 4]);
  assert.equal(records[0].initialObservations, 3);
  assert.equal(records.at(-1).finalObservations, 15);
  assert.equal(records.at(-1).rounds, 4);
});

test("service resource samples are summarized without keeping raw samples", () => {
  const samples = [
    { process: { rss: 100, maxRssBytes: 120, heapUsed: 40, cpuUserMicros: 10, cpuSystemMicros: 5 }, eventLoop: { maxMs: 1 } },
    { process: { rss: 150, maxRssBytes: 170, heapUsed: 60, cpuUserMicros: 40, cpuSystemMicros: 15 }, eventLoop: { maxMs: 3 } },
  ];
  assert.deepEqual(resourceSummary(samples), {
    peakRssBytes: 170,
    peakHeapUsedBytes: 60,
    peakEventLoopDelayMs: 3,
    cpuUserMicros: 30,
    cpuSystemMicros: 10,
    sampleCount: 2,
  });
});

test("the year record totals all days of a run", () => {
  const rounds = [
    { wallStartedAt: "2026-01-01T00:00:00.000Z", wallCorrectAt: "2026-01-01T00:00:05.000Z", endToEndMs: 5000, pushMs: 30, propagationMs: 4970, cumulativeObservations: 4, cumulativeTriples: 40 },
    { wallStartedAt: "2026-01-01T00:00:06.000Z", wallCorrectAt: "2026-01-01T00:00:10.000Z", endToEndMs: 4000, pushMs: 20, propagationMs: 3980, cumulativeObservations: 6, cumulativeTriples: 56 },
  ];
  assert.deepEqual(yearSummary(rounds, 3), {
    type: "year",
    repetition: 3,
    rounds: 2,
    wallStartedAt: "2026-01-01T00:00:00.000Z",
    wallCorrectAt: "2026-01-01T00:00:10.000Z",
    yearWallMs: 10_000,
    sumEndToEndMs: 9000,
    sumPushMs: 50,
    sumPropagationMs: 8950,
    maxEndToEndMs: 5000,
    finalObservations: 6,
    finalTriples: 56,
  });
});

test("records the observed state when the service fails during startup", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-failed-run-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "failed.ndjson");
  const fetchImpl = async (url) => {
    if (url === "http://service/metrics") throw new Error("service process exited");
    if (url === "http://mock/metrics") return Response.json({ observations: 1, triples: 12 });
    throw new Error(`Unexpected URL: ${url}`);
  };

  await assert.rejects(runExperiment(config(1, 1), fetchImpl, { output, repetition: 2 }), /service process exited/);
  const [failure] = (await fs.readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(failure.type, "failure");
  assert.equal(failure.repetition, 2);
  assert.equal(failure.stage, "startup");
  assert.equal(failure.lastCompletedRound, 0);
  assert.equal(failure.triplesAtFailure, 12);
  assert.match(failure.error, /Read service metrics failed .*http:\/\/service\/metrics.*service process exited/);
  assert.equal(failure.errorDetails.request.url, "http://service/metrics");
});
