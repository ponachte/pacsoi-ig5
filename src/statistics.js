export function percentile(sorted, fraction) {
  if (!sorted.length) return undefined;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function descriptiveStatistics(input) {
  const values = input.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return { count: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return {
    count: values.length,
    mean,
    stdev: Math.sqrt(variance),
    min: values[0],
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.at(-1),
  };
}

export function aggregateRecords(records, fields) {
  return Object.fromEntries(fields.map((field) => [
    field,
    descriptiveStatistics(records.map((record) => record[field])),
  ]));
}

export function createSeededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function seedForLabel(seed, label) {
  let value = Number(seed) >>> 0;
  for (const character of String(label)) {
    value = Math.imul(value ^ character.codePointAt(0), 16_777_619) >>> 0;
  }
  return value;
}

function weightedPercentile(sorted, counts, fraction) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const position = (total - 1) * fraction;
  const lowerRank = Math.floor(position);
  const upperRank = Math.ceil(position);
  let seen = 0;
  let lower;
  let upper;
  for (let index = 0; index < counts.length; index += 1) {
    const next = seen + counts[index];
    if (lower === undefined && lowerRank < next) lower = sorted[index];
    if (upperRank < next) {
      upper = sorted[index];
      break;
    }
    seen = next;
  }
  if (lowerRank === upperRank) return lower;
  return lower + (upper - lower) * (position - lowerRank);
}

export function bootstrapPercentiles(input, options = {}) {
  const values = input.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const fractions = options.fractions ?? [0.5, 0.9, 0.95, 0.99];
  const iterations = options.iterations ?? 10_000;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const random = createSeededRandom(options.seed ?? 0);
  if (!values.length) return { sampleSize: 0, percentiles: {} };

  const estimates = new Map(fractions.map((fraction) => [fraction, new Array(iterations)]));
  const counts = new Uint32Array(values.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    counts.fill(0);
    for (let draw = 0; draw < values.length; draw += 1) {
      counts[Math.floor(random() * values.length)] += 1;
    }
    for (const fraction of fractions) {
      estimates.get(fraction)[iteration] = weightedPercentile(values, counts, fraction);
    }
  }

  const alpha = (1 - confidenceLevel) / 2;
  const results = {};
  for (const fraction of fractions) {
    const bootstrapValues = estimates.get(fraction).sort((a, b) => a - b);
    const tailObservations = values.length * (1 - fraction);
    const key = `p${Math.round(fraction * 100)}`;
    results[key] = {
      estimate: percentile(values, fraction),
      ci: {
        confidenceLevel,
        lower: percentile(bootstrapValues, alpha),
        upper: percentile(bootstrapValues, 1 - alpha),
      },
      ...(fraction === 0.5 && values.length < 10 ? {
        warning: `Only ${values.length} independent repetition(s); median interval is weak`,
      } : fraction > 0.5 && tailObservations < 5 ? {
        warning: `Only ${tailObservations.toFixed(2)} expected observation(s) above this percentile; tail estimate is weak`,
      } : {}),
    };
  }
  const descriptive = descriptiveStatistics(values);
  return {
    sampleSize: values.length,
    percentiles: results,
    min: descriptive.min,
    max: descriptive.max,
    ...(options.includeSecondary === false ? {} : {
      secondary: { mean: descriptive.mean, stdev: descriptive.stdev },
    }),
  };
}

export function bootstrapRecords(records, fields, options = {}) {
  return Object.fromEntries(fields.map((field) => [field, bootstrapPercentiles(
    records.map((record) => record[field]),
    { ...options, seed: seedForLabel(options.seed ?? 0, `${options.label ?? "records"}.${field}`) },
  )]));
}

export function bootstrapMeanCI(input, options = {}) {
  const values = input.map(Number).filter(Number.isFinite);
  if (!values.length) return { sampleSize: 0 };
  const iterations = options.iterations ?? 10_000;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const random = createSeededRandom(options.seed ?? 0);
  const estimates = new Array(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sum = 0;
    for (let draw = 0; draw < values.length; draw += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    estimates[iteration] = sum / values.length;
  }
  estimates.sort((a, b) => a - b);
  const alpha = (1 - confidenceLevel) / 2;
  return {
    sampleSize: values.length,
    estimate: values.reduce((sum, value) => sum + value, 0) / values.length,
    ci: {
      confidenceLevel,
      lower: percentile(estimates, alpha),
      upper: percentile(estimates, 1 - alpha),
    },
  };
}

// Peter John Acklam's rational approximation of the inverse standard-normal CDF.
function inverseNormal(probability) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function binomialConfidenceInterval(successes, trials, confidenceLevel = 0.95) {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 1 || successes > trials) {
    throw new Error("Binomial interval requires integer successes and trials with 0 <= successes <= trials");
  }
  const estimate = successes / trials;
  const z = inverseNormal(1 - (1 - confidenceLevel) / 2);
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / trials;
  const center = (estimate + zSquared / (2 * trials)) / denominator;
  const margin = z / denominator * Math.sqrt(
    estimate * (1 - estimate) / trials + zSquared / (4 * trials ** 2),
  );
  return {
    sampleSize: trials,
    estimate,
    ci: {
      confidenceLevel,
      lower: Math.max(0, center - margin),
      upper: Math.min(1, center + margin),
      method: "Wilson score",
    },
  };
}
