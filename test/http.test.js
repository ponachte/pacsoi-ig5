import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../src/http.js";

test("aborts a request that never returns headers", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    fetchWithTimeout(fetchImpl, "http://service/metrics", {}, 10, "Read service metrics"),
    /Read service metrics timed out after 10ms/,
  );
});

test("keeps the timeout active while the response body is being read", async () => {
  let requestSignal;
  const response = {
    body: {},
    async text() {
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
    },
  };
  const fetchImpl = async (_url, { signal }) => {
    requestSignal = signal;
    return response;
  };
  const received = await fetchWithTimeout(fetchImpl, "http://service/w-dist", {}, 10, "Read distribution");
  await assert.rejects(received.text(), /Read distribution timed out after 10ms/);
});
