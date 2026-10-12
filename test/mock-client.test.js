import test from "node:test";
import assert from "node:assert/strict";
import { writeObservationRound } from "../src/mock/client.js";

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
    submitted.push({ url, body: JSON.parse(options.body) });
    return new Response(null, { status: 201 });
  };

  const results = await writeObservationRound(config, 2, fetchImpl);

  assert.deepEqual(results.map(({ observationCount }) => observationCount), [7, 7, 7, 7]);
  assert.deepEqual(submitted.map(({ body }) => body.observations.length), [7, 7, 7, 7]);
});
