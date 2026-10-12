#!/usr/bin/env node
import http from "node:http";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  initialPodData,
  tripleCount,
  WEIGHT_PROPERTY,
  BARIATRIC_PROCEDURE,
} from "../src/mock/data.js";

function json(reply, status, body) {
  reply.writeHead(status, { "Content-Type": "application/json" });
  reply.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function selection(query) {
  if (/\bonbariatricProcedureAdded\b/.test(query)) return { kind: "procedure", root: "onbariatricProcedureAdded" };
  if (/\bonWeightObservationAdded\b/.test(query)) return { kind: "observation", root: "onWeightObservationAdded" };
}

export function createMockPodServer(options = {}) {
  let settings = {
    podPrefix: options.podPrefix ?? "latency",
    podCount: Number(options.podCount ?? 10_000),
    initialObservationsPerPod: Number(options.initialObservationsPerPod ?? 1),
  };
  const pods = new Map();
  const counters = {
    requests: 0,
    changes: 0,
    events: 0,
    abortedRequests: 0,
    earlyResponses: 0,
    handlerErrors: 0,
    clientErrors: 0,
  };
  const lastRequestsBySocket = new WeakMap();
  const socketsWithCloseListener = new WeakSet();
  const logDiagnostic = (event, details = {}) => {
    server.getConnections((error, connections) => {
      const subscriptions = [...pods.values()].reduce(
        (sum, pod) => sum + pod.subscribers.procedure.size + pod.subscribers.observation.size,
        0,
      );
      const record = {
        timestamp: new Date().toISOString(),
        event,
        pid: process.pid,
        ...counters,
        ...details,
        ...(error ? { connectionCountError: error.message } : { connectionCount: connections }),
        subscriptions,
        memory: process.memoryUsage(),
      };
      (options.log ?? ((value) => console.error(`[mock] ${JSON.stringify(value)}`)))(record);
    });
  };

  function baseUrl(request) {
    return options.publicUrl?.replace(/\/$/, "") || `http://${request.headers.host}`;
  }

  function podNumber(podId) {
    if (!podId.startsWith(settings.podPrefix)) return undefined;
    const suffix = podId.slice(settings.podPrefix.length);
    const width = Math.max(3, String(settings.podCount).length);
    if (!new RegExp(`^\\d{${width}}$`).test(suffix)) return undefined;
    const number = Number(suffix);
    return number >= 1 && number <= settings.podCount ? number : undefined;
  }

  function podState(request, podId) {
    let pod = pods.get(podId);
    if (!pod) {
      const number = podNumber(podId);
      if (!number) return undefined;
      pod = {
        ...initialPodData(baseUrl(request), podId, number, settings.initialObservationsPerPod),
        subscribers: { procedure: new Set(), observation: new Set() },
      };
      pods.set(podId, pod);
    }
    return pod;
  }

  function sendEvent(reply, root, value) {
    if (reply.destroyed || reply.writableEnded) return;
    reply.write(`event: next\ndata: ${JSON.stringify({ data: { [root]: value } })}\n\n`);
    counters.events += 1;
  }

  const server = http.createServer(async (request, reply) => {
    const requestNumber = ++counters.requests;
    const started = performance.now();
    let route = "unmatched";
    let acceptedObservations = 0;
    const requestId = request.headers["x-experiment-request-id"];
    const requestDetails = () => ({
      ...(requestId ? { requestId } : {}),
      requestNumber,
      method: request.method,
      url: request.url,
      remoteAddress: request.socket.remoteAddress,
      remotePort: request.socket.remotePort,
      localPort: request.socket.localPort,
      socketBytesRead: request.socket.bytesRead,
      socketBytesWritten: request.socket.bytesWritten,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      route,
      requestComplete: request.complete,
      requestAborted: request.aborted,
      responseStatus: reply.statusCode,
      acceptedObservations,
    });
    const socketContext = { requestId, method: request.method, url: request.url, route };
    lastRequestsBySocket.set(request.socket, socketContext);
    if (!socketsWithCloseListener.has(request.socket)) {
      socketsWithCloseListener.add(request.socket);
      request.socket.once("close", (hadError) => {
        const lastRequest = lastRequestsBySocket.get(request.socket);
        if (lastRequest?.route === "change" && hadError) {
          logDiagnostic("change_socket_closed", {
            ...lastRequest,
            hadError,
          });
        }
      });
    }
    request.on("aborted", () => {
      counters.abortedRequests += 1;
      logDiagnostic("request_aborted", requestDetails());
    });
    request.on("error", (error) => {
      logDiagnostic("request_error", { ...requestDetails(), error: error.message, code: error.code });
    });
    reply.on("error", (error) => {
      logDiagnostic("response_error", { ...requestDetails(), error: error.message, code: error.code });
    });
    reply.on("close", () => {
      if (!reply.writableFinished && route !== "sse") {
        counters.earlyResponses += 1;
        logDiagnostic("response_closed_early", requestDetails());
      }
    });
    try {
      const url = new URL(request.url, baseUrl(request));
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (request.method === "GET" && url.pathname === "/health") {
        route = "health";
        socketContext.route = route;
        return json(reply, 200, { status: "ok", ...settings });
      }
      if (request.method === "GET" && url.pathname === "/configuration") {
        route = "configuration";
        socketContext.route = route;
        return json(reply, 200, settings);
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        route = "metrics";
        socketContext.route = route;
        const subscriptions = [...pods.values()].reduce(
          (sum, pod) => sum + pod.subscribers.procedure.size + pod.subscribers.observation.size,
          0,
        );
        const observations = [...pods.values()].reduce((sum, pod) => sum + pod.observations.length, 0);
        return json(reply, 200, {
          ...counters,
          ...settings,
          materializedPods: pods.size,
          observations,
          triples: tripleCount(pods.size, observations),
          subscriptions,
          memory: process.memoryUsage(),
        });
      }
      if (request.method === "POST" && url.pathname === "/admin/reset") {
        route = "reset";
        socketContext.route = route;
        const subscriptions = [...pods.values()].some(
          (pod) => pod.subscribers.procedure.size || pod.subscribers.observation.size,
        );
        if (subscriptions) return json(reply, 409, { error: "Stop the service before resetting the mock" });
        const body = await requestBody(request);
        const next = {
          podPrefix: String(body.podPrefix || "latency"),
          podCount: Number(body.podCount),
          initialObservationsPerPod: Number(body.initialObservationsPerPod),
        };
        if (!Number.isInteger(next.podCount) || next.podCount < 1 ||
            !Number.isInteger(next.initialObservationsPerPod) || next.initialObservationsPerPod < 1) {
          return json(reply, 400, { error: "podCount and initialObservationsPerPod must be positive integers" });
        }
        settings = next;
        pods.clear();
        for (const key of Object.keys(counters)) counters[key] = 0;
        return json(reply, 200, settings);
      }

      const [podId, resource] = segments;
      const pod = podState(request, podId);
      if (!pod) return json(reply, 404, { error: "Virtual pod not found" });

      if (resource === "changes" && request.method === "POST") {
        route = "change";
        socketContext.route = route;
        const body = await requestBody(request);
        if (!Array.isArray(body.observations)) return json(reply, 400, { error: "observations must be an array" });
        for (const observation of body.observations) {
          if (observation?.sosa_observedProperty !== WEIGHT_PROPERTY ||
              observation?.sosa_hasResult?.saref_isValueOfProperty !== WEIGHT_PROPERTY) continue;
          pod.observations.push(observation);
          acceptedObservations += 1;
          for (const subscriber of pod.subscribers.observation) {
            sendEvent(subscriber, "onWeightObservationAdded", observation);
          }
        }
        counters.changes += 1;
        reply.writeHead(201);
        return reply.end();
      }

      if (resource === "slices" && segments[3] === "query" && request.method === "POST") {
        route = "query";
        socketContext.route = route;
        const body = await requestBody(request);
        const query = String(body.query ?? "");
        const selected = selection(query);
        if (request.headers.accept?.includes("text/event-stream")) {
          if (!selected) return json(reply, 400, { errors: [{ message: "Unsupported subscription" }] });
          route = "sse";
          reply.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          reply.write(": connected\n\n");
          pod.subscribers[selected.kind].add(reply);
          const remove = () => pod.subscribers[selected.kind].delete(reply);
          request.on("close", remove);
          reply.on("close", remove);
          return;
        }
        const data = {};
        if (/\bbariatricProcedures\b/.test(query)) {
          data.bariatricProcedures = pod.procedure.prov_type === BARIATRIC_PROCEDURE ? [pod.procedure] : [];
        }
        if (/\bweightObservations\b/.test(query)) data.weightObservations = pod.observations;
        return json(reply, 200, { data });
      }
      return json(reply, 404, { error: "Unknown mock endpoint" });
    } catch (error) {
      counters.handlerErrors += 1;
      logDiagnostic("request_handler_error", {
        ...requestDetails(),
        error: error.message,
        code: error.code,
      });
      if (!reply.destroyed && !reply.writableEnded && !reply.headersSent) {
        return json(reply, 400, { error: error.message });
      }
    }
  });
  server.on("clientError", (error, socket) => {
    counters.clientErrors += 1;
    const lastParsedRequest = lastRequestsBySocket.get(socket);
    logDiagnostic("client_error", {
      error: error.message,
      code: error.code,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      bytesRead: socket.bytesRead,
      bytesWritten: socket.bytesWritten,
      ...(lastParsedRequest ? { lastParsedRequest } : {}),
    });
    socket.destroy();
  });
  return server;
}

function cliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", default: process.env.MOCK_HOST || "0.0.0.0" },
      port: { type: "string", default: process.env.MOCK_PORT || "3001" },
      "public-url": { type: "string", default: process.env.MOCK_PUBLIC_URL },
      "pod-prefix": { type: "string", default: process.env.POD_PREFIX || "latency" },
      "pod-count": { type: "string", default: process.env.POD_COUNT || "10000" },
      "initial-observations": { type: "string", default: process.env.INITIAL_OBSERVATIONS || "1" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const options = {
    host: values.host,
    port: Number(values.port),
    publicUrl: values["public-url"],
    podPrefix: values["pod-prefix"],
    podCount: Number(values["pod-count"]),
    initialObservationsPerPod: Number(values["initial-observations"]),
  };
  for (const [name, value] of [["port", options.port], ["pod-count", options.podCount], ["initial-observations", options.initialObservationsPerPod]]) {
    if (!Number.isInteger(value) || value < (name === "port" ? 0 : 1)) throw new Error(`--${name} is invalid`);
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = cliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node mock/pod-server.js [options]

Options:
  --host=<address>              Listen address (default: 0.0.0.0)
  --port=<number>               Listen port (default: 3001)
  --public-url=<url>            URL reachable by the service
  --pod-prefix=<prefix>         Virtual pod prefix (default: latency)
  --pod-count=<number>          Number of virtual pods (default: 10000)
  --initial-observations=<n>    Initial weights per pod (default: 1)
  -h, --help                    Show this help`);
    process.exit(0);
  }
  const server = createMockPodServer(options);
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const shownHost = options.host === "0.0.0.0" ? "localhost" : options.host;
    console.log(`Mock pod server listening on ${options.publicUrl || `http://${shownHost}:${address.port}`}`);
  });
}
