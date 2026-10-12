import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout } from "../src/http.js";

test("aborts a request that never returns headers", async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await assert.rejects(
    fetchWithTimeout(fetchImpl, "http://service/metrics", {}, 10, "Read service metrics"),
    (error) => {
      assert.match(error.message, /Read service metrics timed out after 10ms/);
      assert.equal(error.name, "TimeoutError");
      const { elapsedMs, ...request } = error.request;
      assert.deepEqual(request, {
        operation: "Read service metrics",
        url: "http://service/metrics",
        method: "GET",
        timeoutMs: 10,
        phase: "response",
        outcome: "timeout",
      });
      assert.ok(elapsedMs >= 0);
      return true;
    },
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
  await assert.rejects(received.text(), (error) => {
    assert.match(error.message, /Read distribution timed out after 10ms/);
    assert.equal(error.request.phase, "response-body");
    assert.equal(error.request.outcome, "timeout");
    return true;
  });
});

test("adds request and nested network error details when fetch fails", async () => {
  const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const fetchImpl = async () => {
    throw Object.assign(new TypeError("fetch failed", { cause }), { code: "UND_ERR_SOCKET" });
  };

  await assert.rejects(
    fetchWithTimeout(fetchImpl, "http://mock/pod-1/changes", { method: "POST" }, 500, "Submit mock change"),
    (error) => {
      assert.match(error.message, /Submit mock change failed .*http:\/\/mock\/pod-1\/changes.*fetch failed/);
      assert.equal(error.request.method, "POST");
      assert.equal(error.request.outcome, "network-error");
      assert.equal(error.cause.code, "UND_ERR_SOCKET");
      assert.equal(error.cause.cause.code, "ECONNRESET");
      return true;
    },
  );
});
