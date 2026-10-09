import { randomInt } from "node:crypto";
import { expectResponse } from "../http.js";
import { podIds } from "../inventory.js";
import { initialWeightValue, roundPodData } from "./data.js";

export async function resetMock(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.mock.serverUrl}/admin/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      podPrefix: config.experiment.podPrefix,
      podCount: config.experiment.podCount,
      initialObservationsPerPod: config.experiment.initialObservationsPerPod,
    }),
  });
  return expectResponse(response, 200, "Reset mock pod server");
}

export function initialValues(config) {
  const values = [];
  for (let podNumber = 1; podNumber <= config.experiment.podCount; podNumber += 1) {
    for (let index = 0; index < config.experiment.initialObservationsPerPod; index += 1) {
      values.push(initialWeightValue(podNumber, index));
    }
  }
  return values;
}

export async function submitPodChange(config, podId, round, observationCount, fetchImpl = fetch) {
  const data = roundPodData(config.mock.serverUrl, podId, round, observationCount);
  const started = performance.now();
  const response = await fetchImpl(`${config.mock.serverUrl}/${encodeURIComponent(podId)}/changes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ observations: data.observations }),
  });
  await expectResponse(response, 201, `Submit mock change for ${podId}`);
  return {
    podId,
    observationCount,
    values: data.values,
    acceptedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
  };
}

export async function writeObservationRound(config, round, fetchImpl = fetch) {
  const ids = podIds(config.experiment);
  const results = new Array(ids.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(config.experiment.writeConcurrency, ids.length) }, async () => {
    while (next < ids.length) {
      const index = next;
      next += 1;
      const count = randomInt(
        config.experiment.minObservationsPerPod,
        config.experiment.maxObservationsPerPod + 1,
      );
      results[index] = await submitPodChange(config, ids[index], round, count, fetchImpl);
    }
  });
  await Promise.all(workers);
  return results;
}
