import test from "node:test";
import assert from "node:assert/strict";
import { deletePod, provisionPod } from "../src/kvasir/pods.js";

test("pod provisioning creates matching owner and per-pod administrative identities", async () => {
  let request;
  const config = {
    kvasir: {
      serverUrl: "https://kvasir.example",
      clientId: "setup-client",
      clientSecret: "setup-secret",
    },
  };
  const result = await provisionPod(
    config,
    {
      podId: "latency001",
      username: "latency001",
      adminClientId: "latency001client",
      adminClientSecret: "latency001client",
    },
    async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return new Response(undefined, { status: 201 });
    },
  );

  assert.equal(request.url, "https://kvasir.example");
  assert.equal(request.body["kss:name"], "latency001");
  assert.equal(request.body["kss:ownerUserId"], "latency001");
  assert.equal(request.body["kss:adminClientId"], "latency001client");
  assert.equal(request.body["kss:adminClientSecret"], "latency001client");
  assert.deepEqual(result, {
    podId: "latency001",
    username: "latency001",
    adminClientId: "latency001client",
    url: "https://kvasir.example/latency001",
    created: true,
  });
});

test("pod cleanup uses the lowercase service client when available", async () => {
  const requests = [];
  const responses = [
    new Response(undefined, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer as_uri="https://idp.example/realms/kvasir"' },
    }),
    Response.json({ token_endpoint: "https://idp.example/token" }),
    Response.json({ access_token: "owner-token" }),
    new Response(undefined, { status: 204 }),
  ];
  const identity = {
    podId: "latency001",
    username: "latency001",
    adminClientId: "latency001client",
    adminClientSecret: "latency001client",
  };
  const result = await deletePod(
    { kvasir: { serverUrl: "https://kvasir.example" } },
    identity,
    async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    },
  );

  assert.deepEqual(result, { podId: "latency001", deleted: true });
  assert.equal(requests[2].url, "https://idp.example/token");
  assert.match(requests[2].init.headers.Authorization, /^Basic /);
  assert.equal(requests[3].url, "https://kvasir.example/latency001");
  assert.equal(requests[3].init.method, "DELETE");
  assert.equal(requests[3].init.headers.Authorization, "Bearer owner-token");
});

test("pod cleanup falls back to the legacy uppercase Client credentials", async () => {
  const requests = [];
  const challenge = () => new Response(undefined, {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer as_uri="https://idp.example/realms/kvasir"' },
  });
  const metadata = () => Response.json({ token_endpoint: "https://idp.example/token" });
  const responses = [
    challenge(),
    metadata(),
    Response.json({ error: "invalid_client" }, { status: 401 }),
    challenge(),
    metadata(),
    Response.json({ error: "invalid_client" }, { status: 401 }),
    challenge(),
    metadata(),
    Response.json({ access_token: "legacy-owner-token" }),
    new Response(undefined, { status: 204 }),
  ];
  const identity = {
    podId: "latency001",
    username: "latency001",
    adminClientId: "latency001client",
    adminClientSecret: "latency001client",
  };

  const result = await deletePod(
    { kvasir: { serverUrl: "https://kvasir.example" } },
    identity,
    async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return responses.shift();
    },
  );

  assert.deepEqual(result, { podId: "latency001", deleted: true });
  assert.match(requests[2].init.headers.Authorization, /^Basic /);
  assert.equal(requests[5].init.body.get("client_id"), "latency001client");
  assert.equal(requests[8].init.body.get("client_id"), "latency001Client");
  assert.equal(requests[9].init.headers.Authorization, "Bearer legacy-owner-token");
});
