import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRunReport, readRun } from "../src/report.js";

function fixtureRecords() {
  return [
    {
      type: "startup",
      podCount: 2,
      initialObservations: 4,
      benchmarkWaitMs: 10,
      observedServiceUptimeMs: 100,
      resources: { peakRssBytes: 100 * 1024 * 1024, peakHeapUsedBytes: 50 * 1024 * 1024, cpuUserMicros: 10, cpuSystemMicros: 5 },
    },
    {
      type: "round",
      round: 1,
      observationsAdded: 2,
      cumulativeObservations: 6,
      expectedAverage: 82,
      pushMs: 20,
      propagationMs: 5,
      endToEndMs: 25,
      endToEndLowerBoundMs: 22,
      metricsPolls: 3,
      distributionRequestMs: 1.5,
      resources: { peakRssBytes: 110 * 1024 * 1024, peakHeapUsedBytes: 55 * 1024 * 1024, cpuUserMicros: 1000, cpuSystemMicros: 500, peakEventLoopP95Ms: 2 },
    },
    { type: "year", rounds: 1, yearWallMs: 25, sumEndToEndMs: 25 },
  ];
}

test("streams day records and the year record", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = path.join(directory, "run.ndjson");
  await fs.writeFile(run, fixtureRecords().map(JSON.stringify).join("\n"));
  const parsed = await readRun(run);

  assert.equal(parsed.rounds.length, 1);
  assert.equal(parsed.rounds[0].pushMs, 20);
  assert.equal(parsed.rounds[0].propagationMs, 5);
  assert.equal(parsed.rounds[0].endToEndLowerBoundMs, 22);
  assert.equal(parsed.rounds[0].distributionRequestMs, 1.5);
  assert.equal(parsed.rounds[0].cpuSeconds, 0.0015);
  assert.equal(parsed.year.yearWallMs, 25);
});

test("generates a self-contained HTML report with an OOM annotation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-report-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = path.join(directory, "run.ndjson");
  const error = path.join(directory, "error.txt");
  await fs.writeFile(run, fixtureRecords().map(JSON.stringify).join("\n"));
  await fs.writeFile(error, "Mark-Compact 3900 (4129.3) MB\nFATAL ERROR: JavaScript heap out of memory\n");

  const result = await generateRunReport(run, { errorFile: error });
  const html = await fs.readFile(result.output, "utf8");
  assert.equal(result.rounds, 1);
  assert.equal(result.failure, "JavaScript heap out of memory");
  assert.match(html, /PACSOI run report/);
  assert.match(html, /Detected heap limit/);
  assert.match(html, /Daily latency/);
  assert.match(html, /Distribution request cost/);
  assert.match(html, /How to read/);
  assert.match(html, /height:460px/);
  assert.doesNotMatch(html, /https?:\/\/[^"']+\.js/);
});

test("reads failure records from a partial run", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pacsoi-partial-run-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const run = path.join(directory, "partial.ndjson");
  await fs.writeFile(run, JSON.stringify({
    type: "failure", stage: "startup", lastCompletedTriples: 0, triplesAtFailure: 44,
  }));
  const parsed = await readRun(run, { allowPartial: true });
  assert.equal(parsed.startup, undefined);
  assert.equal(parsed.failure.triplesAtFailure, 44);
});
