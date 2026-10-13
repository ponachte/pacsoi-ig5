#!/usr/bin/env node
// Virtual Kvasir-style pod server. Every pod exposes the GraphQL slice the
// service queries and subscribes to. Pod contents are never stored: they are a
// pure function of the pod number and the current day, so memory stays flat
// however many days are pushed.
import http from "node:http";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { SLICE_NAME } from "../src/scenario.js";
import { observation, podId, podNumber, procedure, tripleCount } from "../src/mock/data.js";

function json(reply, status, body) {
  reply.writeHead(status, { "Content-Type": "application/json" });
  reply.end(JSON.stringify(body));
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function subscriptionKind(query) {
  if (/\bonbariatricProcedureAdded\b/.test(query)) return "procedure";
  if (/\bonWeightObservationAdded\b/.test(query)) return "observation";
  return undefined;
}

function sseEvent(root, value) {
  return `event: next\ndata: ${JSON.stringify({ data: { [root]: value } })}\n\n`;
}

// Resolves once `chunk` has been handed to the socket, or the socket is gone.
function writeEvent(reply, chunk) {
  if (reply.destroyed || reply.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => reply.write(chunk, (error) => resolve(!error)));
}

export function createMockPodServer({ podCount, writeConcurrency = 100, publicUrl, log } = {}) {
  if (!Number.isInteger(podCount) || podCount < 1) throw new Error("podCount must be a positive integer");
  if (!Number.isInteger(writeConcurrency) || writeConcurrency < 1) throw new Error("writeConcurrency must be a positive integer");
  let day = 0;
  let pushing = false;
  const subscribers = new Map();
  const counters = { requests: 0, snapshots: 0, events: 0, handlerErrors: 0, clientErrors: 0 };
  const logDiagnostic = log ?? ((record) => console.error(`[mock] ${JSON.stringify(record)}`));

  const baseUrl = (request) => publicUrl?.replace(/\/$/, "") || `http://${request.headers.host}`;
  const podSubscribers = (id) => {
    let pod = subscribers.get(id);
    if (!pod) {
      pod = { procedure: new Set(), observation: new Set() };
      subscribers.set(id, pod);
    }
    return pod;
  };
  const subscriptionCount = () => [...subscribers.values()]
    .reduce((sum, pod) => sum + pod.procedure.size + pod.observation.size, 0);

  // Emits day `next` to every pod in pod order, so the input stream is
  // identical in every run. Pods are written in waves of `writeConcurrency`:
  // the next wave starts once every event of the previous one has been handed
  // to its socket, so at most that many notifications are in flight. Refuses
  // to push while any pod lacks a weight subscription: that event would be
  // lost and the day could never complete.
  async function pushDay(request, next) {
    if (pushing) return { status: 409, body: { error: `Day ${day} is still being pushed` } };
    if (next !== day + 1) return { status: 409, body: { error: `Next day is ${day + 1}, received ${next}` } };
    for (let number = 1; number <= podCount; number += 1) {
      const id = podId(number, podCount);
      if (!subscribers.get(id)?.observation.size) {
        return { status: 409, body: { error: `Pod ${id} has no weight subscription; day ${next} not pushed` } };
      }
    }
    pushing = true;
    const started = performance.now();
    day = next;
    let events = 0;
    let waves = 0;
    try {
      for (let first = 1; first <= podCount; first += writeConcurrency) {
        const writes = [];
        for (let number = first; number < first + writeConcurrency && number <= podCount; number += 1) {
          const id = podId(number, podCount);
          const event = sseEvent("onWeightObservationAdded", observation(baseUrl(request), id, number, day));
          for (const reply of subscribers.get(id).observation) writes.push(writeEvent(reply, event));
        }
        events += (await Promise.all(writes)).filter(Boolean).length;
        waves += 1;
      }
    } finally {
      pushing = false;
      counters.events += events;
    }
    return { status: 200, body: { day, pods: podCount, events, waves, writeConcurrency, pushMs: performance.now() - started } };
  }

  function query(request, reply, id, body) {
    if (request.headers.accept?.includes("text/event-stream")) {
      const kind = subscriptionKind(body.query ?? "");
      if (!kind) return json(reply, 400, { errors: [{ message: "Unsupported subscription" }] });
      reply.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      reply.write(": connected\n\n");
      const set = podSubscribers(id)[kind];
      set.add(reply);
      reply.on("close", () => set.delete(reply));
      return undefined;
    }
    counters.snapshots += 1;
    const number = podNumber(id, podCount);
    const data = {};
    if (/\bbariatricProcedures\b/.test(body.query ?? "")) data.bariatricProcedures = [procedure(baseUrl(request), id)];
    if (/\bweightObservations\b/.test(body.query ?? "")) {
      data.weightObservations = Array.from({ length: day + 1 }, (_, past) => observation(baseUrl(request), id, number, past));
    }
    return json(reply, 200, { data });
  }

  const server = http.createServer(async (request, reply) => {
    counters.requests += 1;
    try {
      const url = new URL(request.url, "http://mock");
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(reply, 200, { status: "ok", podCount, writeConcurrency, day });
      }
      if (request.method === "GET" && url.pathname === "/metrics") {
        return json(reply, 200, {
          ...counters,
          podCount,
          writeConcurrency,
          day,
          observations: podCount * (day + 1),
          triples: tripleCount(podCount, podCount * (day + 1)),
          subscriptions: subscriptionCount(),
          memory: process.memoryUsage(),
        });
      }
      if (request.method === "POST" && segments[0] === "admin" && segments[1] === "days" && segments.length === 3) {
        const result = await pushDay(request, Number(segments[2]));
        return json(reply, result.status, result.body);
      }
      if (request.method === "POST" && segments.length === 4 && segments[1] === "slices" &&
          segments[2] === SLICE_NAME && segments[3] === "query" && podNumber(segments[0], podCount)) {
        return query(request, reply, segments[0], await requestBody(request));
      }
      return json(reply, 404, { error: "Unknown mock endpoint" });
    } catch (error) {
      counters.handlerErrors += 1;
      logDiagnostic({ timestamp: new Date().toISOString(), event: "handler_error", url: request.url, error: error.message });
      if (!reply.headersSent) json(reply, 400, { error: error.message });
      return undefined;
    }
  });
  server.on("clientError", (error, socket) => {
    counters.clientErrors += 1;
    logDiagnostic({ timestamp: new Date().toISOString(), event: "client_error", error: error.message, code: error.code });
    socket.destroy();
  });
  return server;
}

function cliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string", default: "0.0.0.0" },
      port: { type: "string", default: "3001" },
      "public-url": { type: "string" },
      "pod-count": { type: "string" },
      "write-concurrency": { type: "string", default: "100" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  const options = {
    host: values.host,
    port: Number(values.port),
    publicUrl: values["public-url"],
    podCount: Number(values["pod-count"]),
    writeConcurrency: Number(values["write-concurrency"]),
  };
  if (!Number.isInteger(options.port) || options.port < 0) throw new Error("--port is invalid");
  if (!Number.isInteger(options.podCount) || options.podCount < 1) throw new Error("--pod-count is required");
  if (!Number.isInteger(options.writeConcurrency) || options.writeConcurrency < 1) throw new Error("--write-concurrency is invalid");
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = cliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node mock/pod-server.js --pod-count=<n> [options]

Options:
  --pod-count=<number>  Number of virtual pods (required)
  --write-concurrency=<n>  Pods notified per wave when a day is pushed (default: 100)
  --host=<address>      Listen address (default: 0.0.0.0)
  --port=<number>       Listen port (default: 3001)
  --public-url=<url>    URL reachable by the service
  -h, --help            Show this help`);
    process.exit(0);
  }
  const server = createMockPodServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`Mock pod server listening on ${options.publicUrl || `http://localhost:${server.address().port}`}`);
  });
}
