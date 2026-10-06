import { expectResponse } from "../http.js";
import { podIds, podUrl } from "../inventory.js";
import { readState, writeState } from "../state.js";

export async function registerAggregator(config, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.aggregator.serverUrl}/registration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ registration_type: "none" }),
  });
  const body = await expectResponse(response, 201, "Register aggregator with none flow");
  if (!body?.aggregator_id) throw new Error("Aggregator registration response has no aggregator_id");
  const state = { aggregatorId: body.aggregator_id };
  await writeState("aggregator.json", state);
  return state;
}

function turtleString(value) {
  return JSON.stringify(String(value));
}

export function buildServiceRequest(config, servicesUrl, catalogUrl) {
  const serviceUrl = `${servicesUrl.replace(/\/$/, "")}/${encodeURIComponent(config.aggregator.serviceName)}`;
  const deploymentUrl = `${catalogUrl.replace(/\/$/, "")}/${encodeURIComponent(config.aggregator.deploymentFunction)}`;
  const sources = podIds(config.experiment).map((podId) => podUrl(config, podId));
  const predicate = `${deploymentUrl}#${config.aggregator.sourceParameter}`;
  const body = [
    "@prefix aggr: <https://w3id.org/aggregator#> .",
    `<${serviceUrl}> a aggr:ServiceRequest ;`,
    `  aggr:deploymentFunction <${deploymentUrl}> ;`,
    `  <${predicate}> ${turtleString(JSON.stringify(sources))} .`,
    "",
  ].join("\n");
  return { body, serviceUrl, sources };
}

export async function deployService(config, fetchImpl = fetch) {
  const state = await readState("aggregator.json");
  if (!state?.aggregatorId) throw new Error("No aggregator state. Run `latency-lab aggregator register` first.");
  const aggregatorUrl = new URL(state.aggregatorId, `${config.aggregator.serverUrl}/`).href.replace(/\/$/, "");
  const description = await expectResponse(await fetchImpl(aggregatorUrl, { headers: { Accept: "application/json" } }), 200, "Read aggregator description");
  const servicesUrl = description.service_collection || `${aggregatorUrl}/services`;
  const catalogUrl = description.deployment_catalog || `${config.aggregator.serverUrl}/deployments`;
  const request = buildServiceRequest(config, servicesUrl, catalogUrl);
  const response = await fetchImpl(servicesUrl, { method: "POST", headers: { "Content-Type": "text/turtle" }, body: request.body });
  await expectResponse(response, [201, 202, 409], "Deploy PACSOI service");
  const nextState = {
    ...state,
    aggregatorUrl,
    serviceUrl: request.serviceUrl,
    sources: request.sources,
    weightUrl: `${request.serviceUrl}/${config.aggregator.weightPath}`,
  };
  await writeState("aggregator.json", nextState);
  return nextState;
}
