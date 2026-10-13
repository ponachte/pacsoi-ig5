import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMockPodServer } from "../mock/pod-server.js";
import { observation } from "../src/mock/data.js";

async function fixture(t, podCount = 2, writeConcurrency = 100) {
  const server = createMockPodServer({ podCount, writeConcurrency, log: () => {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const queryUrl = (base, pod) => `${base}/${pod}/slices/pacsoi-latency/query`;

async function subscribe(t, base, pod, field) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(queryUrl(base, pod), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ query: `subscription { ${field} { id } }` }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  await reader.read();
  return reader;
}

async function snapshot(base, pod) {
  const response = await fetch(queryUrl(base, pod), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ bariatricProcedures { id subject } weightObservations { id } }" }),
  });
  return (await response.json()).data;
}

test("the snapshot holds the procedure and every observation up to the current day", async (t) => {
  const base = await fixture(t, 1);
  const initial = await snapshot(base, "latency001");
  assert.equal(initial.bariatricProcedures.length, 1);
  assert.equal(initial.bariatricProcedures[0].subject, `${base}/latency001/patients/main`);
  assert.deepEqual(initial.weightObservations.map(({ id }) => id), [observation(base, "latency001", 1, 0).id]);

  await subscribe(t, base, "latency001", "onWeightObservationAdded");
  assert.equal((await fetch(`${base}/admin/days/1`, { method: "POST" })).status, 200);
  assert.equal((await snapshot(base, "latency001")).weightObservations.length, 2);
  const metrics = await (await fetch(`${base}/metrics`)).json();
  assert.equal(metrics.day, 1);
  assert.equal(metrics.observations, 2);
  assert.equal(metrics.triples, 4 + 2 * 8);
});

test("a day is pushed once to every pod in pod order", async (t) => {
  const base = await fixture(t);
  const first = await subscribe(t, base, "latency001", "onWeightObservationAdded");
  const second = await subscribe(t, base, "latency002", "onWeightObservationAdded");
  await subscribe(t, base, "latency001", "onbariatricProcedureAdded");

  const response = await fetch(`${base}/admin/days/1`, { method: "POST" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.day, 1);
  assert.equal(body.events, 2);
  assert.ok(body.pushMs >= 0);
  for (const [reader, pod] of [[first, "latency001"], [second, "latency002"]]) {
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.match(event, /^event: next\ndata: .*onWeightObservationAdded/);
    assert.ok(event.includes(observation(base, pod, Number(pod.slice(-3)), 1).id));
  }
});

test("a day is pushed in waves of the configured write concurrency", async (t) => {
  const base = await fixture(t, 5, 2);
  const readers = [];
  for (let number = 1; number <= 5; number += 1) {
    readers.push(await subscribe(t, base, `latency00${number}`, "onWeightObservationAdded"));
  }
  assert.equal((await (await fetch(`${base}/health`)).json()).writeConcurrency, 2);
  const body = await (await fetch(`${base}/admin/days/1`, { method: "POST" })).json();
  assert.deepEqual([body.events, body.waves, body.writeConcurrency], [5, 3, 2]);
  for (const [index, reader] of readers.entries()) {
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.ok(event.includes(`latency00${index + 1}/weight-observations/day-1`));
  }
});

test("refuses days out of order and days that would be lost", async (t) => {
  const base = await fixture(t);
  await subscribe(t, base, "latency001", "onWeightObservationAdded");
  const missing = await fetch(`${base}/admin/days/1`, { method: "POST" });
  assert.equal(missing.status, 409);
  assert.match((await missing.json()).error, /latency002 has no weight subscription/);
  await subscribe(t, base, "latency002", "onWeightObservationAdded");
  const skipped = await fetch(`${base}/admin/days/2`, { method: "POST" });
  assert.equal(skipped.status, 409);
  assert.match((await skipped.json()).error, /Next day is 1/);
  assert.equal((await (await fetch(`${base}/health`)).json()).day, 0);
});

test("memory does not grow with pushed days", async (t) => {
  const base = await fixture(t, 200);
  await Promise.all(Array.from({ length: 200 }, (_, index) =>
    subscribe(t, base, `latency${String(index + 1).padStart(3, "0")}`, "onWeightObservationAdded")));
  for (let day = 1; day <= 50; day += 1) {
    assert.equal((await fetch(`${base}/admin/days/${day}`, { method: "POST" })).status, 200);
  }
  const metrics = await (await fetch(`${base}/metrics`)).json();
  assert.equal(metrics.observations, 200 * 51);
  assert.equal(metrics.events, 200 * 50);
  assert.ok(metrics.memory.heapUsed < 100 * 1024 * 1024);
});

test("unknown pods, slices, and routes are rejected", async (t) => {
  const base = await fixture(t);
  for (const url of [`${base}/latency003/slices/pacsoi-latency/query`, `${base}/latency001/slices/other/query`, `${base}/latency001/changes`]) {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 404);
  }
});
