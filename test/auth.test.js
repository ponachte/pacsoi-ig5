import test from "node:test";
import assert from "node:assert/strict";
import { bearerAuthorizationServer } from "../src/kvasir/auth.js";

test("discovers the authorization server from a mixed challenge", () => {
  const header = 'Bearer realm="kvasir", as_uri="https://idp.example/realms/kvasir", UMA realm="uma"';
  assert.equal(bearerAuthorizationServer(header), "https://idp.example/realms/kvasir");
});

