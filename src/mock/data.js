import { randomUUID } from "node:crypto";

export const WEIGHT_PROPERTY = "http://snomed.info/id/27113001";
export const BARIATRIC_PROCEDURE = "http://snomed.info/id/442338001";
export const PROCEDURE_AT = "2020-01-15T10:00:00.000Z";

export function patientUrl(serverUrl, podId) {
  return `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(podId)}/patients/main`;
}

export function initialWeightValue(podNumber, index) {
  return Number((80 + (podNumber % 100) / 100 + index / 10).toFixed(2));
}

export function initialPodData(serverUrl, podId, podNumber, observationCount) {
  const patient = patientUrl(serverUrl, podId);
  const procedure = {
    id: `${serverUrl}/${encodeURIComponent(podId)}/procedures/bariatric`,
    subject: patient,
    prov_type: BARIATRIC_PROCEDURE,
    prov_startedAtTime: PROCEDURE_AT,
  };
  const observations = Array.from({ length: observationCount }, (_, index) => observation(
    serverUrl,
    podId,
    patient,
    initialWeightValue(podNumber, index),
    `2020-02-${String(Math.min(28, index + 1)).padStart(2, "0")}T10:00:00.000Z`,
    `initial-${index + 1}`,
  ));
  return { patient: { id: patient }, procedure, observations };
}

export function roundPodData(serverUrl, podId, round, observationCount) {
  const patient = patientUrl(serverUrl, podId);
  const observations = Array.from({ length: observationCount }, (_, index) => observation(
    serverUrl,
    podId,
    patient,
    Number((80 + round * 2 + index / 10 + podId.length / 100).toFixed(2)),
    `2020-02-${String(Math.min(28, round + index + 1)).padStart(2, "0")}T10:00:00.000Z`,
    randomUUID(),
  ));
  return { observations, values: observations.map((item) => item.sosa_hasResult.saref_hasValue) };
}

function observation(serverUrl, podId, patient, value, timestamp, id) {
  const base = `${serverUrl.replace(/\/$/, "")}/${encodeURIComponent(podId)}`;
  return {
    id: `${base}/weight-observations/${id}`,
    sosa_hasFeatureOfInterest: patient,
    sosa_observedProperty: WEIGHT_PROPERTY,
    sosa_hasResult: {
      id: `${base}/weight-values/${id}`,
      saref_isValueOfProperty: WEIGHT_PROPERTY,
      saref_hasValue: value,
      saref_hasTimestamp: timestamp,
    },
  };
}
