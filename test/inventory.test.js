import test from "node:test";
import assert from "node:assert/strict";
import { podAdminCredentials, podIdentities, podIds } from "../src/inventory.js";

test("pod inventory is deterministic and ordered", () => {
  assert.deepEqual(podIds({ podPrefix: "test", podCount: 3 }), ["test001", "test002", "test003"]);
});

test("pod administrative credentials use the same generated value", () => {
  assert.deepEqual(podAdminCredentials("latency001"), {
    clientId: "latency001client",
    clientSecret: "latency001client",
  });
});

test("pod IDs and usernames use the same compact latency001 identity", () => {
  assert.deepEqual(
    podIdentities({ podPrefix: "latency", podCount: 1 }),
    [{
      podId: "latency001",
      username: "latency001",
      adminClientId: "latency001client",
      adminClientSecret: "latency001client",
    }],
  );
});
