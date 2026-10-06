import { expectResponse } from "../http.js";

export const anonymousUser = "urn:kvasir-user:anonymous";

export function anonymousReaderGrant(resourceUrl) {
  return {
    "@context": {
      kss: "https://kvasir.discover.ilabt.imec.be/vocab#",
      "kss-fga": "https://kvasir.discover.ilabt.imec.be/fine-grained-access#",
    },
    "kss:insert": [{
      "@id": anonymousUser,
      "@type": "kss-fga:User",
      "kss-fga:reader": { "@id": resourceUrl, "@type": "kss-fga:Resource" },
    }],
  };
}

export function hasAnonymousReaderGrant(listing, resourceUrl) {
  const entries = Array.isArray(listing?.["@graph"]) ? listing["@graph"] : [listing];
  return entries.some((entry) => {
    if (entry?.["@id"] !== anonymousUser) return false;
    const readers = Array.isArray(entry["kss-fga:reader"]) ? entry["kss-fga:reader"] : [entry["kss-fga:reader"]];
    return readers.some((resource) => resource?.["@id"] === resourceUrl);
  });
}

export async function grantAnonymousRead(podBaseUrl, resourceUrl, token, fetchImpl = fetch) {
  const headers = { Authorization: `Bearer ${token}` };
  const listing = await expectResponse(
    await fetchImpl(`${podBaseUrl}/rebac/relationships`, { headers }),
    200,
    `Inspect ReBAC relationships for ${podBaseUrl}`,
  );
  if (hasAnonymousReaderGrant(listing, resourceUrl)) return { created: false };
  const response = await fetchImpl(`${podBaseUrl}/rebac/relationships`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/ld+json" },
    body: JSON.stringify(anonymousReaderGrant(resourceUrl)),
  });
  await expectResponse(response, [200, 201, 204], `Grant anonymous read on ${resourceUrl}`);
  return { created: true };
}
