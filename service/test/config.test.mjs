import assert from "node:assert/strict";
import test from "node:test";
import { buildPodSources, readConfig } from "../dist/config.js";

test("builds a deterministic virtual pod inventory without a large environment variable", () => {
  const sources = buildPodSources("http://mock:3001/", "latency", 10_000);
  assert.equal(sources.length, 10_000);
  assert.equal(sources[0], "http://mock:3001/latency00001");
  assert.equal(sources.at(-1), "http://mock:3001/latency10000");
});

test("reads standalone service configuration", () => {
  assert.deepEqual(readConfig({
    POD_SERVER_URL: "http://mock:3001",
    POD_PREFIX: "test",
    POD_COUNT: "2",
    SLICE_NAME: "pacsoi-latency",
    PORT: "4000",
  }), {
    podBaseUrls: ["http://mock:3001/test001", "http://mock:3001/test002"],
    sliceName: "pacsoi-latency",
    port: 4000,
  });
});
