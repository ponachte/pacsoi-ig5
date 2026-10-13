import test from "node:test";
import assert from "node:assert/strict";
import {
  monthBucket,
  observation,
  observationTimestamp,
  podId,
  podNumber,
  weightValue,
} from "../src/mock/data.js";

test("pod IDs match the service inventory and parse back", () => {
  assert.equal(podId(1, 3), "latency001");
  assert.equal(podId(1, 10_000), "latency00001");
  assert.equal(podId(10_000, 10_000), "latency10000");
  assert.equal(podNumber("latency00042", 10_000), 42);
  assert.equal(podNumber("latency0042", 10_000), undefined);
  assert.equal(podNumber("latency10001", 10_000), undefined);
  assert.equal(podNumber("other00001", 10_000), undefined);
});

test("observations are byte-for-byte deterministic and dated one day apart", () => {
  const first = observation("http://mock.example", "latency00042", 42, 3);
  assert.equal(JSON.stringify(first), JSON.stringify(observation("http://mock.example", "latency00042", 42, 3)));
  assert.match(first.id, /latency00042\/weight-observations\/day-3$/);
  assert.equal(first.sosa_hasResult.saref_hasTimestamp, "2020-01-18T10:00:00.000Z");
  assert.equal(observationTimestamp(0), "2020-01-15T10:00:00.000Z");
  assert.deepEqual([weightValue(1, 2), weightValue(2, 2)], [89.16, 90.53]);
});

test("a year of days spreads over thirteen month buckets", () => {
  assert.equal(monthBucket(observationTimestamp(16)), 0);
  assert.equal(monthBucket(observationTimestamp(17)), 1);
  assert.equal(observationTimestamp(365), "2021-01-14T10:00:00.000Z");
  const months = new Set(Array.from({ length: 366 }, (_, day) => monthBucket(observationTimestamp(day))));
  assert.deepEqual([...months], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test("weights stay physiologically plausible for a whole year", () => {
  for (let number = 1; number <= 10_000; number += 37) {
    for (let day = 0; day <= 365; day += 1) {
      const value = weightValue(number, day);
      assert.ok(value >= 60 && value <= 135, `pod ${number} day ${day}: ${value}`);
    }
  }
  assert.ok(weightValue(1, 365) < weightValue(1, 0) - 15, "weights decline after the procedure");
});
