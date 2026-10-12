import test from "node:test";
import assert from "node:assert/strict";
import { roundPodData } from "../src/mock/data.js";

test("round data is byte-for-byte deterministic", () => {
  const first = roundPodData("http://mock.example", "latency00042", 3, 4);
  const second = roundPodData("http://mock.example", "latency00042", 3, 4);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.match(first.observations[0].id, /round-3-observation-1$/);
  assert.match(first.observations[0].sosa_hasResult.id, /round-3-observation-1$/);
});

test("round weights vary deterministically by pod sequence", () => {
  const podOne = roundPodData("http://mock.example", "latency00001", 2, 2);
  const podTwo = roundPodData("http://mock.example", "latency00002", 2, 2);

  assert.deepEqual(podOne.values, [84.01, 84.11]);
  assert.deepEqual(podTwo.values, [84.02, 84.12]);
});

test("round data requires the deterministic numeric pod sequence", () => {
  assert.throws(
    () => roundPodData("http://mock.example", "latency", 1, 1),
    /numeric sequence/,
  );
});
