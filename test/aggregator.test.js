import test from "node:test";
import assert from "node:assert/strict";
import { buildServiceRequest } from "../src/aggregator/client.js";
import { validateConfig } from "../src/config.js";

test("PACSOI latency deployment receives every configured pod", () => {
  const config = validateConfig({
    kvasir: { serverUrl: "https://kvasir.example", clientId: "setup", clientSecret: "secret" },
    aggregator: {
      serverUrl: "https://aggregator.example",
      deploymentFunction: "pacsoi-latency",
      serviceName: "latency-run",
    },
    experiment: { podCount: 3 },
  });

  const request = buildServiceRequest(
    config,
    "https://aggregator.example/aggregators/1/services",
    "https://aggregator.example/deployments",
  );

  assert.deepEqual(request.sources, [
    "https://kvasir.example/latency001",
    "https://kvasir.example/latency002",
    "https://kvasir.example/latency003",
  ]);
  assert.match(request.body, /pacsoi-latency#sources/);
  assert.match(request.body, /\[\\"https:\/\/kvasir\.example\/latency001\\",\\"https:\/\/kvasir\.example\/latency002\\",\\"https:\/\/kvasir\.example\/latency003\\"\]/);
});
