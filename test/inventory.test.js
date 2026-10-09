import test from "node:test";
import assert from "node:assert/strict";
import { podIds } from "../src/inventory.js";

test("virtual pod inventory is deterministic and ordered", () => {
  assert.deepEqual(podIds({ podPrefix: "test", podCount: 3 }), ["test001", "test002", "test003"]);
  const large = podIds({ podPrefix: "test", podCount: 10_000 });
  assert.equal(large[0], "test00001");
  assert.equal(large.at(-1), "test10000");
});
