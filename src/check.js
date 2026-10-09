import { expectResponse } from "./http.js";

export async function check(config, fetchImpl = fetch) {
  const mock = await expectResponse(
    await fetchImpl(`${config.mock.serverUrl}/configuration`),
    200,
    "Reach mock pod server",
  );
  const expected = config.experiment;
  for (const key of ["podPrefix", "podCount", "initialObservationsPerPod"]) {
    if (mock[key] !== expected[key]) {
      throw new Error(`Mock ${key}=${mock[key]} does not match configuration value ${expected[key]}; run mock reset`);
    }
  }
  const service = await expectResponse(
    await fetchImpl(`${config.service.serverUrl}/health`),
    200,
    "Reach standalone service",
  );
  if (service.podCount !== expected.podCount) {
    throw new Error(`Service podCount=${service.podCount} does not match configuration value ${expected.podCount}`);
  }
  return { mock, service };
}
