import { expectResponse } from "../http.js";
import { podIdentities, podUrl } from "../inventory.js";
import { clientToken, passwordToken } from "./auth.js";

export async function provisionPod(config, identity, fetchImpl = fetch) {
  const { podId, username, adminClientId, adminClientSecret } = identity;
  const response = await fetchImpl(config.kvasir.serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/ld+json" },
    body: JSON.stringify({
      "@context": { kss: "https://kvasir.discover.ilabt.imec.be/vocab#" },
      "kss:name": podId,
      "kss:ownerUserId": username,
      "kss:adminClientId": adminClientId,
      "kss:adminClientSecret": adminClientSecret,
      "kss:configuration": "{}",
    }),
  });
  await expectResponse(response, [201, 409], `Provision pod ${podId}`);
  const created = response.status === 201;
  return {
    podId,
    username,
    adminClientId,
    url: podUrl(config, podId),
    created,
    ...(created ? {} : { note: "Existing pods retain their original owner; provisioning cannot repair that identity." }),
  };
}

export async function provisionPods(config, fetchImpl = fetch) {
  const results = [];
  for (const identity of podIdentities(config.experiment)) {
    results.push(await provisionPod(config, identity, fetchImpl));
  }
  return results;
}

export async function deletePod(config, identity, fetchImpl = fetch) {
  const baseUrl = podUrl(config, identity.podId);
  const currentCredentials = { clientId: identity.adminClientId, clientSecret: identity.adminClientSecret };
  try {
    const serviceToken = await clientToken(currentCredentials, `${baseUrl}/changes`, fetchImpl);
    const serviceResponse = await fetchImpl(baseUrl, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    if ([200, 201, 204, 404].includes(serviceResponse.status)) {
      await serviceResponse.text();
      return { podId: identity.podId, deleted: serviceResponse.status !== 404 };
    }
    await serviceResponse.text();
  } catch {
    // Migration fallback below handles pods made with older client conventions.
  }

  let token;
  const legacyClient = `${identity.podId}Client`;
  const credentialCandidates = [
    currentCredentials,
    { clientId: legacyClient, clientSecret: legacyClient },
  ].filter((credentials, index, entries) =>
    entries.findIndex((entry) => entry.clientId === credentials.clientId) === index
  );
  const failures = [];
  for (const credentials of credentialCandidates) {
    try {
      token = await passwordToken(
        credentials,
        identity.username,
        identity.username,
        `${baseUrl}/changes`,
        fetchImpl,
      );
      break;
    } catch (error) {
      failures.push(`${credentials.clientId}: ${error.message}`);
    }
  }
  if (!token) {
    throw new Error(
      `Cannot authenticate pod owner ${identity.username} for cleanup. ` +
      `Cleanup expects the initial owner password to equal the username. Tried: ${failures.join("; ")}`,
    );
  }

  const response = await fetchImpl(baseUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  await expectResponse(response, [200, 201, 204, 404], `Delete pod ${identity.podId}`);
  return { podId: identity.podId, deleted: response.status !== 404 };
}

export async function deletePods(config, fetchImpl = fetch) {
  const results = [];
  for (const identity of podIdentities(config.experiment).reverse()) {
    results.push(await deletePod(config, identity, fetchImpl));
  }
  return results;
}
