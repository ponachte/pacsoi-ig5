import { expectResponse } from "../http.js";

export function bearerAuthorizationServer(header) {
  if (!header) throw new Error("Kvasir did not return WWW-Authenticate");
  const bearer = header.match(/(?:^|,)\s*Bearer\s+([\s\S]*?)(?=,\s*(?:UMA|Basic|Digest|DPoP)\b|$)/i)?.[1];
  const match = bearer?.match(/(?:^|,)\s*as_uri=(?:"([^"]+)"|([^,\s]+))/i);
  if (!match) throw new Error(`Kvasir Bearer challenge has no as_uri: ${header}`);
  return match[1] || match[2];
}

export async function discoverTokenEndpoint(protectedUrl, fetchImpl = fetch) {
  const challenge = await fetchImpl(protectedUrl);
  if (challenge.status !== 401 && challenge.status !== 403) {
    throw new Error(`Expected an authentication challenge from ${protectedUrl}, got ${challenge.status}`);
  }
  const authorizationServer = bearerAuthorizationServer(challenge.headers.get("www-authenticate"));
  const metadataResponse = await fetchImpl(`${authorizationServer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const metadata = await expectResponse(metadataResponse, 200, "OIDC discovery");
  if (!metadata?.token_endpoint) throw new Error("OIDC metadata has no token_endpoint");
  return metadata.token_endpoint;
}

export async function clientToken(credentials, protectedUrl, fetchImpl = fetch) {
  const tokenEndpoint = await discoverTokenEndpoint(protectedUrl, fetchImpl);
  const basicCredentials = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicCredentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  const body = await expectResponse(response, 200, "Kvasir client-credentials exchange");
  if (!body?.access_token) throw new Error("Token response has no access_token");
  return body.access_token;
}

export async function passwordToken(credentials, username, password, protectedUrl, fetchImpl = fetch) {
  const tokenEndpoint = await discoverTokenEndpoint(protectedUrl, fetchImpl);
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      username,
      password,
      scope: "openid profile",
    }),
  });
  const body = await expectResponse(response, 200, `Kvasir password exchange for ${username}`);
  if (!body?.access_token) throw new Error(`Token response for ${username} has no access_token`);
  return body.access_token;
}
