# PACSOI IG5 mock-pod scale lab

This repository measures a standalone PACSOI aggregation service against a
single-process virtual pod server. It has no external Kvasir or Aggregator
dependency.

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
- `minObservationsPerPod` and `maxObservationsPerPod`: additions per pod/round;
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
```

Run all tests with `npm run test:all`.
