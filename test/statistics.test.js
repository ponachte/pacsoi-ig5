import test from "node:test";
import assert from "node:assert/strict";
import { binomialConfidenceInterval, bootstrapMeanCI, bootstrapPercentiles, descriptiveStatistics } from "../src/statistics.js";
import { tripleCount } from "../src/mock/data.js";

test("descriptive statistics include sample deviation and interpolated percentiles", () => {
  assert.deepEqual(descriptiveStatistics([1, 2, 3, 4, 5]), {
    count: 5,
    mean: 3,
    stdev: Math.sqrt(2.5),
    min: 1,
    p50: 3,
    p90: 4.6,
    p95: 4.8,
    p99: 4.96,
    max: 5,
  });
});

test("triple workload counts procedures and observation result pairs", () => {
  assert.equal(tripleCount(2, 4), 40);
  assert.equal(tripleCount(10_000, 10_000), 120_000);
});

test("bootstrap percentile intervals are deterministic and preserve the observed estimate", () => {
  const options = { iterations: 2_000, confidenceLevel: 0.95, seed: 1234 };
  const first = bootstrapPercentiles([1, 2, 3, 4, 5], options);
  const second = bootstrapPercentiles([1, 2, 3, 4, 5], options);

  assert.deepEqual(first, second);
  assert.equal(first.percentiles.p50.estimate, 3);
  assert.ok(first.percentiles.p50.ci.lower >= 1);
  assert.ok(first.percentiles.p50.ci.upper <= 5);
  assert.match(first.percentiles.p95.warning, /tail estimate is weak/);
  assert.equal(bootstrapPercentiles([1, 2, 3], { iterations: 10, includeSecondary: false }).secondary, undefined);
});

test("failure-rate bootstrap estimates the observed attempt rate", () => {
  const result = bootstrapMeanCI([0, 0, 0, 1], { iterations: 2_000, seed: 99 });
  assert.equal(result.estimate, 0.25);
  assert.ok(result.ci.lower >= 0);
  assert.ok(result.ci.upper <= 1);
});

test("Wilson failure interval remains uncertain when no failures were observed", () => {
  const result = binomialConfidenceInterval(0, 3, 0.95);
  assert.equal(result.estimate, 0);
  assert.equal(result.ci.lower, 0);
  assert.ok(result.ci.upper > 0.5);
  assert.equal(result.ci.method, "Wilson score");
});
