import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { createMockPodServer } from "../mock/pod-server.js";
import { roundPodData } from "../src/mock/data.js";

async function fixture(t, options = {}) {
  const server = createMockPodServer({
    podPrefix: "latency", podCount: 10_000, initialObservationsPerPod: 2, ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.closeAllConnections());
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("10,000 virtual pods allocate no pod state before use", async (t) => {
  const base = await fixture(t);
  const metrics = await (await fetch(`${base}/metrics`)).json();
  assert.equal(metrics.podCount, 10_000);
  assert.equal(metrics.materializedPods, 0);
  assert.equal(metrics.triples, 0);
  assert.ok(metrics.memory.heapUsed < 100 * 1024 * 1024);
});

test("initial query returns seeded procedure and weight data", async (t) => {
  const base = await fixture(t);
  const response = await fetch(`${base}/latency00001/slices/pacsoi-latency/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ bariatricProcedures { id subject } weightObservations { id } }" }),
  });
  const body = await response.json();
  assert.equal(body.data.bariatricProcedures.length, 1);
  assert.equal(body.data.weightObservations.length, 2);
  assert.equal(body.data.bariatricProcedures[0].subject, `${base}/latency00001/patients/main`);
  const metrics = await (await fetch(`${base}/metrics`)).json();
  assert.equal(metrics.observations, 2);
  assert.equal(metrics.triples, 20);
});

test("round changes are published once over the incremental stream", async (t) => {
  const base = await fixture(t);
  const podId = "latency00001";
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/${podId}/slices/pacsoi-latency/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ query: "subscription { onWeightObservationAdded { id sosa_hasResult { saref_hasValue } } }" }),
    signal: controller.signal,
  });
  const reader = stream.body.getReader();
  await reader.read();
  const data = roundPodData(base, podId, 1, 1);
  const response = await fetch(`${base}/${podId}/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ observations: data.observations }),
  });
  assert.equal(response.status, 201);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /onWeightObservationAdded/);
  assert.equal((await (await fetch(`${base}/metrics`)).json()).events, 1);
});

test("logs client-aborted change requests with socket, progress, and resource details", async (t) => {
  let logAborted;
  const aborted = new Promise((resolve) => { logAborted = resolve; });
  const base = await fixture(t, {
    log: (record) => {
      if (record.event === "request_aborted") logAborted(record);
    },
  });
  const url = new URL(`${base}/latency00001/changes`);
  const request = http.request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "100",
      "X-Experiment-Request-Id": "test-request-123",
    },
  });
  request.on("error", () => {});
  request.write("{");
  setTimeout(() => request.destroy(), 20);

  const record = await aborted;
  assert.equal(record.method, "POST");
  assert.equal(record.url, "/latency00001/changes");
  assert.equal(record.requestId, "test-request-123");
  assert.equal(record.route, "change");
  assert.equal(record.requestAborted, true);
  assert.equal(record.acceptedObservations, 0);
  assert.ok(Number.isInteger(record.connectionCount));
  assert.ok(record.memory.rss > 0);
});
