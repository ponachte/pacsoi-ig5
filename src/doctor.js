import { expectResponse } from "./http.js";
import { podIds, queryUrl } from "./inventory.js";

export async function doctor(config, fetchImpl = fetch) {
  await expectResponse(await fetchImpl(config.kvasir.serverUrl, { headers: { Accept: "application/ld+json" } }), 200, "Reach Kvasir server");
  await expectResponse(await fetchImpl(config.aggregator.serverUrl), 200, "Reach Aggregator server");
  for (const podId of podIds(config.experiment)) {
    const response = await fetchImpl(queryUrl(config, podId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ patients { id } bariatricProcedures { id } weightObservations { id } }" }),
    });
    await expectResponse(response, 200, `Anonymous query for ${podId}`);
  }
}
