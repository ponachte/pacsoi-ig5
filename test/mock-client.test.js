import test from "node:test";
import assert from "node:assert/strict";
import { submitPodChange, writeObservationRound } from "../src/mock/client.js";

test("every pod receives the configured fixed observation count", async () => {
  const submitted = [];
  const config = {
    mock: { serverUrl: "http://mock.example" },
    experiment: {
      podPrefix: "fixed",
      podCount: 4,
      writeConcurrency: 3,
      observationsPerPodPerRound: 7,
    },
  };
  const fetchImpl = async (url, options) => {
    submitted.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(null, { status: 201 });
  };

  const results = await writeObservationRound(config, 2, fetchImpl);

  assert.deepEqual(results.map(({ observationCount }) => observationCount), [7, 7, 7, 7]);
  assert.deepEqual(submitted.map(({ body }) => body.observations.length), [7, 7, 7, 7]);
  assert.ok(submitted.every(({ headers }) => headers["X-Experiment-Request-Id"]));
  assert.equal(new Set(submitted.map(({ headers }) => headers["X-Experiment-Request-Id"])).size, 4);
});

test("does not replay a write after a network failure and keeps its correlation ID", async () => {
  let calls = 0;
  const config = {
    mock: { serverUrl: "http://mock.example" },
    experiment: { requestTimeoutMs: 100, observationsPerPodPerRound: 2 },
  };
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "http://mock.example/latency00001/changes");
    assert.match(options.headers["X-Experiment-Request-Id"], /^[0-9a-f-]{36}$/);
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    throw new TypeError("fetch failed", { cause });
  };

  await assert.rejects(
    submitPodChange(config, "latency00001", 2, 2, fetchImpl),
    (error) => {
      assert.equal(error.request.requestId.length, 36);
      assert.equal(error.request.outcome, "network-error");
      return true;
    },
  );

  assert.equal(calls, 1);
});
