# PACSOI IG5 mock-pod scale lab

This repository measures a standalone PACSOI aggregation service against a
single-process virtual pod server.

The experiment answers two questions:

- how much CPU, memory, and event-loop time the service uses for N pods; and
- how long a round takes from pushing changes to all N pods until `/w-dist`
  returns the complete correct result.

## Configuration

Requires Node.js 20 or newer. Copy the example:

```sh
cp config.example.json config.json
```

The important experiment settings are:

- `podCount`: number of virtual pods;
- `initialObservationsPerPod`: weights present before the service starts;
- `iterations`: number of change rounds;
- `repetitions`: number of independent runs in a full experiment;
- `retryCount`: automatic clean restarts allowed after a failed repetition;
- `observationsPerPodPerRound`: the exact number of additions sent to every pod in every round;
- `bootstrapIterations`: offline resamples used for confidence intervals;
- `bootstrapConfidenceLevel`: confidence level, normally `0.95`;
- `bootstrapSeed`: makes regenerated statistical results reproducible;
- `requestTimeoutMs`: maximum time for one HTTP response, including its body;
- `progressIntervalMs`: interval for in-progress round phase/accepted-pod output;
- `writeConcurrency`: maximum simultaneous change requests; and
- `resourceSampleIntervalMs`: service metrics sampling interval.

Pod IDs are deterministic. At 10,000 pods they range from `latency00001` to
`latency10000`.

## Run locally

Start and seed the virtual pod server:

```sh
npm run mock:server
node bin/latency-lab.js mock reset
```

Start the standalone service in another terminal:

```sh
POD_SERVER_URL=http://localhost:3001 \
POD_PREFIX=latency \
POD_COUNT=10000 \
SLICE_NAME=pacsoi-latency \
npm --prefix service start
```

Then validate and run:

```sh
node bin/latency-lab.js check
node bin/latency-lab.js run
```

Or run the complete, managed experiment with no separately started processes:

```sh
node bin/latency-lab.js experiment
```

This builds the service once, then starts a fresh mock and service for every
repetition. It waits for their health endpoints, resets and verifies the mock,
checks the service configuration, runs the benchmark, and shuts both processes
down. A failed attempt is cleaned up and retried according to `retryCount`.
Managed mode currently requires local `http://localhost` or `127.0.0.1` URLs.

The mock must be reset before starting the service. Resetting while incremental
subscriptions are connected is rejected to prevent mixed experiment state.

## Run the service as a container

Yes, the service runs directly as a Docker container; the Aggregator is not
needed. Build it with:

```sh
docker build -t pacsoi-latency:latest service
```

When the mock runs on the Docker host on Linux, one example is:

```sh
docker run --rm --network host \
  -e POD_SERVER_URL=http://127.0.0.1:3001 \
  -e POD_PREFIX=latency \
  -e POD_COUNT=10000 \
  -e SLICE_NAME=pacsoi-latency \
  -e PORT=3000 \
  pacsoi-latency:latest
```

The mock also has an optional container image:

```sh
docker build -f mock/Dockerfile -t pacsoi-pod-mock:latest .
```

Set `--public-url`/`MOCK_PUBLIC_URL` when the address seen by the service differs
from the mock's listen address.

## What is measured

Every virtual pod begins with one bariatric procedure and the configured number
of deterministic weight observations. Starting the service loads that complete
initial state and opens two incremental streams per pod: procedure and weight.

The benchmark first waits for the exact initial count and average. Each round
then:

1. pushes new weight observations to every pod with bounded concurrency;
2. calculates the exact cumulative count and average;
3. polls `/w-dist` until the full answer matches;
4. records write-phase, post-last-write propagation, and end-to-end duration;
5. samples `/metrics` throughout the round; and
6. appends the result to `results/run-*.ndjson`.

Resource output includes process-lifetime peak RSS, sampled peak heap, cumulative
user/system CPU, event-loop p95, and the raw samples. The first NDJSON record is
a `startup` result with service uptime and CPU since launch; following records
have `type: "round"` and report CPU consumed during that round.

The mock exposes `/health`, `/configuration`, and `/metrics`. The service exposes
`/health`, `/metrics`, and `/w-dist`.

A full experiment writes one NDJSON file plus separate mock and service logs per attempt,
plus `summary.json` and `report.html` under `results/experiment-*`. Latency,
resource, and throughput metrics contain p50, p90, p95, and p99 estimates with
reproducible percentile-bootstrap confidence intervals. Experiment repetitions
are the independent resampling unit and rounds are never mixed. Means and sample
standard deviations remain secondary diagnostics. Tail estimates receive a
warning when too few independent repetitions support them. Failed attempts and
their Wilson-score failure-rate interval remain visible even when a retry succeeds.
An exhausted repetition does not stop later repetitions. Completed rounds from
partial attempts remain in the per-round statistics, so the sample count can
decline at higher triple counts. Each failure records its stage and round, the
last fully completed triple count, the mock-observed triple count when failure
was detected, the last service-observed processed triple count, and whether the
service log contains a Node.js out-of-memory error. Together these distinguish
the exact safe round boundary, the latest sampled Incremunica state, and the
accepted-input upper bound at the moment failure was detected.
JavaScript heap exhaustion is classified from the service log. A bare `SIGKILL`
is reported separately as `process-killed`, since it may indicate the operating
system OOM killer but is not sufficient evidence to label it definitively.
Every service, mock, and pod-write request has a bounded timeout, including body
streaming. While a round is running, periodic output identifies whether it is
writing, propagating, or finalizing and reports elapsed time and accepted pods.
`requestTimeoutMs` is the limit for one HTTP request, not the limit for a whole
round. Timeout failures identify the operation, URL, request phase, and elapsed
time; other fetch failures include the nested Node.js cause and network error
code when available. The failure record also captures the round phase and
accepted-pod count, which helps distinguish a slow request from a connection
reset or refusal during a large write batch.
Each mock change POST carries a unique `X-Experiment-Request-Id`. The client
includes that ID in any fetch failure details; mock-side request and socket
diagnostics log it when the request reaches the HTTP handler. Parser-level
socket errors also include the most recent parsed request on that socket as
context, which may be an earlier keep-alive request rather than the malformed
or reset request itself. Writes are not automatically retried because a socket
failure can happen after the mock applied a write but before the client received
its response.
The experiment controller also watches the managed service and mock processes.
An unexpected exit immediately aborts the active request, preserves the partial
run and completed child log, classifies the failure, and starts the next attempt.
The mock writes structured diagnostics to its attempt log when a request is
aborted, a response closes before completion, request handling fails, or the
HTTP parser rejects a client connection. These records include the request
route, remote address, accepted observations, active SSE subscription and TCP
connection counts, and mock memory usage; normal request traffic is not logged.
Failed-attempt summaries also include both child-process exit codes and signals.

All generated input data is deterministic. Observation and result identifiers
are derived from pod, round, and observation index; weights vary deterministically
by numeric pod sequence, round, and index; and procedure/observation timestamps
are fixed functions of their indexes. Repeated experiments therefore send the
same payload data.

## Scale expectations

Virtual pod definitions are lazy: declaring 10,000 pods does not create 10,000
processes, databases, or records in advance. The dominant cost is the service's
two long-lived GraphQL/SSE streams per pod. A 10,000-pod run therefore maintains
about 20,000 connections on both the service and mock hosts.

For the full-scale run, raise the open-file limit on both hosts. A larger VM is
most likely to be useful for the service, whose query engine owns the stream and
aggregation state. `/metrics` makes it possible to run smaller steps first and
identify the point where memory, CPU, or event-loop delay starts growing sharply.

## Commands

```text
latency-lab mock reset
latency-lab check
latency-lab run
latency-lab experiment
latency-lab report results/run-*.ndjson --error results/error.txt
```

The `report` command streams one run file and creates a self-contained offline
HTML report beside it. It includes summary cards, latency, memory, CPU,
event-loop pressure, workload, throughput, per-pod write percentiles, a sortable
round table, and an optional failure annotation.

Run all tests with `npm run test:all`.
