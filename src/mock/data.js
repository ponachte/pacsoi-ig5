import { POD_PREFIX } from "../scenario.js";

export const WEIGHT_PROPERTY = "http://snomed.info/id/27113001";
export const BARIATRIC_PROCEDURE = "http://snomed.info/id/442338001";
export const PROCEDURE_AT = "2020-01-15T10:00:00.000Z";
const PROCEDURE_DATE = new Date(PROCEDURE_AT);
const DAY_MS = 24 * 60 * 60 * 1000;

// The GraphQL-LD schemas materialize four triples for a procedure and eight
// for every weight observation (four for the observation and four for its
// result node).
export const PROCEDURE_TRIPLES = 4;
export const WEIGHT_OBSERVATION_TRIPLES = 8;

export function tripleCount(podCount, observationCount) {
  return podCount * PROCEDURE_TRIPLES + observationCount * WEIGHT_OBSERVATION_TRIPLES;
}

// Same IDs as the service builds from POD_PREFIX and POD_COUNT.
export function podId(podNumber, podCount) {
  return `${POD_PREFIX}${String(podNumber).padStart(Math.max(3, String(podCount).length), "0")}`;
}

export function podNumber(id, podCount) {
  const width = Math.max(3, String(podCount).length);
  const match = id.match(new RegExp(`^${POD_PREFIX}(\\d{${width}})$`));
  const number = match ? Number(match[1]) : 0;
  return number >= 1 && number <= podCount ? number : undefined;
}

export function patientUrl(serverUrl, id) {
  return `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}/patients/main`;
}

// Day 0 is the day of the procedure; day d is the d-th daily weigh-in.
export function observationTimestamp(day) {
  return new Date(PROCEDURE_DATE.getTime() + day * DAY_MS).toISOString();
}

// Same bucketing as WeightDistribution.record in service/src/distribution.ts:
// calendar months between the procedure and the observation, in UTC.
export function monthBucket(timestamp) {
  const date = new Date(timestamp);
  return (date.getUTCFullYear() - PROCEDURE_DATE.getUTCFullYear()) * 12
    + date.getUTCMonth() - PROCEDURE_DATE.getUTCMonth();
}

// A deterministic post-bariatric trajectory: a per-pod baseline between 90 and
// 130 kg, a loss that levels off at 25 kg, and +/-1 kg of day-to-day noise.
export function weightValue(number, day) {
  const baseline = 90 + ((number * 37) % 4000) / 100;
  const loss = 25 * (1 - Math.exp(-day / 120));
  const noise = (((number * 31 + day * 17) % 21) - 10) / 10;
  return Number((baseline - loss + noise).toFixed(2));
}

export function procedure(serverUrl, id) {
  return {
    id: `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}/procedures/bariatric`,
    subject: patientUrl(serverUrl, id),
    prov_type: BARIATRIC_PROCEDURE,
    prov_startedAtTime: PROCEDURE_AT,
  };
}

export function observation(serverUrl, id, number, day) {
  const base = `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(id)}`;
  return {
    id: `${base}/weight-observations/day-${day}`,
    sosa_hasFeatureOfInterest: patientUrl(serverUrl, id),
    sosa_observedProperty: WEIGHT_PROPERTY,
    sosa_hasResult: {
      id: `${base}/weight-values/day-${day}`,
      saref_isValueOfProperty: WEIGHT_PROPERTY,
      saref_hasValue: weightValue(number, day),
      saref_hasTimestamp: observationTimestamp(day),
    },
  };
}
