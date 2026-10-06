import fs from "node:fs/promises";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { projectRoot } from "../config.js";
import { expectResponse } from "../http.js";
import { podAdminCredentials, podIds, podUrl, queryUrl, sliceUrl } from "../inventory.js";
import { clientToken } from "./auth.js";
import { grantAnonymousRead } from "./rebac.js";

const WEIGHT_PROPERTY = "http://snomed.info/id/27113001";
const BARIATRIC_PROCEDURE = "http://snomed.info/id/442338001";
const PROCEDURE_AT = "2020-01-15T10:00:00.000Z";

const context = {
  kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
  foaf: "http://xmlns.com/foaf/0.1/",
  prov: "http://www.w3.org/ns/prov#",
  saref: "https://saref.etsi.org/core/",
  sosa: "http://www.w3.org/ns/sosa/",
  sphn: "https://sphn.ch/",
  xsd: "http://www.w3.org/2001/XMLSchema#",
};

const dateTime = (value) => ({ "@value": value, "@type": "xsd:dateTime" });
const decimal = (value) => ({ "@value": String(value), "@type": "xsd:double" });

export function patientUri(config, podId) {
  return `${podUrl(config, podId)}/patients/main`;
}

export async function registerSlice(config, podId, token, fetchImpl = fetch) {
  const schema = await fs.readFile(path.join(projectRoot, "schemas", "latency.graphql"), "utf8");
  const response = await fetchImpl(`${podUrl(config, podId)}/slices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/ld+json" },
    body: JSON.stringify({
      "@context": { kss: context.kss },
      "kss:name": config.experiment.sliceName,
      "kss:description": "Combined patient, bariatric-procedure, and weight-observation latency slice.",
      "kss:schema": { "@type": "kss:EmbeddedSliceSchema", "kss:sdl": schema },
    }),
  });
  if (response.status === 401 || response.status === 403) {
    await response.text();
    throw new Error(`Pod client ${podId}client is not authorized to create slices on ${podId}`);
  }
  await expectResponse(response, [201, 409], `Register slice for ${podId}`);
}

export async function verifyAnonymousQuery(config, podId, fetchImpl = fetch) {
  const response = await fetchImpl(queryUrl(config, podId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "{ patients { id } bariatricProcedures { id } weightObservations { id } }" }),
  });
  const body = await expectResponse(response, 200, `Verify anonymous slice query for ${podId}`);
  if (body?.errors?.length) throw new Error(`Anonymous query failed for ${podId}: ${body.errors.map(({ message }) => message).join("; ")}`);
}

export async function submitChange(config, podId, insert, fetchImpl = fetch) {
  const baseUrl = podUrl(config, podId);
  const token = await clientToken(podAdminCredentials(podId), `${baseUrl}/changes`, fetchImpl);
  const started = performance.now();
  const response = await fetchImpl(`${baseUrl}/changes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/ld+json" },
    body: JSON.stringify({ "@context": context, "kss:insert": insert }),
  });
  await expectResponse(response, 201, `Submit data change for ${podId}`);
  return {
    podId,
    acceptedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    location: response.headers.get("location"),
  };
}

export function topologyRecords(config, podId) {
  return [{ "@id": patientUri(config, podId), "@type": "foaf:Person" }];
}

export async function setupSlices(config, fetchImpl = fetch) {
  const ids = podIds(config.experiment);
  for (const podId of ids) {
    try {
      const baseUrl = podUrl(config, podId);
      const token = await clientToken(podAdminCredentials(podId), `${baseUrl}/changes`, fetchImpl);
      await registerSlice(config, podId, token, fetchImpl);
      await grantAnonymousRead(baseUrl, sliceUrl(config, podId), token, fetchImpl);
      await grantAnonymousRead(baseUrl, queryUrl(config, podId), token, fetchImpl);
      await verifyAnonymousQuery(config, podId, fetchImpl);
      await submitChange(config, podId, topologyRecords(config, podId), fetchImpl);
    } catch (error) {
      throw new Error(`Slice setup failed for ${podId}: ${error.message}`, { cause: error });
    }
  }
}

export function roundRecords(config, podId, round, observationCount) {
  const patient = patientUri(config, podId);
  const procedure = `${podUrl(config, podId)}/procedures/bariatric`;
  const records = [];
  if (round === 1) {
    records.push(
      { "@id": patient, "@type": "foaf:Person", "sphn:hasIntervention": { "@id": procedure } },
      {
        "@id": procedure,
        "@type": "sphn:MedicalProcedure",
        "prov:type": { "@id": BARIATRIC_PROCEDURE },
        "prov:startedAtTime": dateTime(PROCEDURE_AT),
      },
    );
  }

  const values = [];
  for (let index = 0; index < observationCount; index += 1) {
    const id = randomUUID();
    const value = Number((80 + round * 2 + index / 10 + podId.length / 100).toFixed(2));
    const timestamp = `2020-02-${String(Math.min(28, round + index + 1)).padStart(2, "0")}T10:00:00.000Z`;
    const result = `${podUrl(config, podId)}/weight-values/${id}`;
    values.push(value);
    records.push(
      {
        "@id": `${podUrl(config, podId)}/weight-observations/${id}`,
        "@type": "sosa:Observation",
        "sosa:hasFeatureOfInterest": { "@id": patient },
        "sosa:hasResult": { "@id": result },
        "sosa:observedProperty": { "@id": WEIGHT_PROPERTY },
      },
      {
        "@id": result,
        "@type": "saref:PropertyValue",
        "saref:isValueOfProperty": { "@id": WEIGHT_PROPERTY },
        "saref:hasValue": decimal(value),
        "saref:hasTimestamp": dateTime(timestamp),
      },
    );
  }
  return { records, values };
}

export async function writeObservationRound(config, round, fetchImpl = fetch) {
  const minimum = config.experiment.minObservationsPerPod;
  const maximum = config.experiment.maxObservationsPerPod;
  return Promise.all(podIds(config.experiment).map(async (podId) => {
    const observationCount = randomInt(minimum, maximum + 1);
    const { records, values } = roundRecords(config, podId, round, observationCount);
    const change = await submitChange(config, podId, records, fetchImpl);
    return { ...change, observationCount, values };
  }));
}
