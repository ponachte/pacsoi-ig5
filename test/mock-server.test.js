import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMockPodServer } from "../mock/pod-server.js";
import { roundPodData } from "../src/mock/data.js";

async function fixture(t) {
  const server = createMockPodServer({ podPrefix: "latency", podCount: 10_000, initialObservationsPerPod: 2 });
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
