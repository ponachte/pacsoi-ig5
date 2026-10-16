# PACSOI IG5 latency lab

This repository measures how a standalone PACSOI aggregation service, built on
Incremunica, keeps up with a growing amount of pod data. It runs one fixed,
deterministic scenario:

- every patient pod holds one bariatric procedure and one weight observation;
- every simulated day, every pod receives one new weight observation;
- after each day the lab measures how long the service takes, from the moment
  the day's observations are pushed until `/w-dist` returns the complete and
  correct distribution, and what CPU and memory the service uses.

By default this is 10,000 pods for 365 days, repeated 50 times: a final state
of 3.66 million observations, about 29.3 million triples. A repetition in
which the service runs out of memory is a result, not an error to retry.

## Run the experiment

Requires Node.js 20 or newer.

```sh
npm --prefix service install
node bin/latency-lab.js experiment
```

The experiment builds the service once, then for every repetition starts a
fresh mock pod server and service, waits until the service has loaded the
initial pods and opened every subscription, runs all days, and stops both
processes. Results are written to `results/experiment-<timestamp>/`:

- `repetition-NNN.ndjson`: one startup record, one record per day, and a year
  record (or a failure record);
- `repetition-NNN-service.log` and `repetition-NNN-mock.log`;
- `summary.json`: bootstrap statistics across repetitions, failures; and
- `report.html`: a self-contained report of the summary.

`node bin/latency-lab.js report results/experiment-*/repetition-001.ndjson`
renders a report for one repetition.

### Configuration

Everything that could make two runs of the same scale differ is fixed in
[`src/scenario.js`](src/scenario.js): the data, the push order, poll and sample
intervals, timeouts, and bootstrap settings. `config.json` (optional; see
`config.example.json`, or point `LATENCY_LAB_CONFIG` at another file) accepts
only:

| Key | Default | Purpose |
|---|---|---|
| `service.version` | `memory` | engine under test: `memory` or `level` (LevelDB-backed) |
| `service.distribution` | `recompute` | how `/w-dist` statistics are computed: `recompute` on every read, or maintained `incremental`ly (see [Read-query benchmark](#read-query-benchmark)) |
| `experiment.podCount` | `10000` | number of pods |
| `experiment.days` | `365` | number of simulated days |
| `experiment.repetitions` | `50` | independent repetitions |
| `experiment.writeConcurrency` | `100` | pods notified per wave when the mock pushes a day |
| `experiment.serviceMaxOldSpaceMiB` | Node default | heap limit of the service process |
| `mock.serverUrl`, `service.serverUrl` | `http://localhost:3001`, `:3000` | local ports |

Any other key is rejected. Use a small scale (for example 100 pods for 40 days,
one repetition) to check a machine before a full run, and a medium run (10,000
pods for 30 days) to estimate per-day time and memory growth.

Set `serviceMaxOldSpaceMiB` below the VM's free memory so the service fails
with its own heap error rather than being killed by the operating system. With
the `level` engine part of the data lives outside the JavaScript heap, so an OS
kill remains possible.

### Run in the background with tmux

```sh
mkdir -p results
tmux new-session -d -s pacsoi-experiment \
  'node bin/latency-lab.js experiment > results/experiment-console.log 2>&1'
tail -f results/experiment-console.log
```

**Ctrl+C** stops `tail`, not the experiment. `tmux attach -t pacsoi-experiment`
attaches; **Ctrl+B**, then **D** detaches again. `tmux ls` shows whether it is
still running.

## The workload

The mock pod server ([`mock/pod-server.js`](mock/pod-server.js)) stands in for
a Kvasir server. Each pod exposes the GraphQL slice
`/<pod>/slices/pacsoi-latency/query`, which the service uses in two ways, both
only while starting:

1. a snapshot query for the pod's current procedure and observations; and
2. two subscriptions (procedure, weight) kept open as server-sent events.

Pod contents are never stored. They are a pure function of the pod number and
the current day ([`src/mock/data.js`](src/mock/data.js)), so the mock's memory
stays flat however many days are pushed and can never be the first process to
run out of memory:

- observation `d` of a pod is dated `d` days after the procedure (2020-01-15),
  so a year spreads over 13 month buckets (months 0–12);
- weights follow a post-surgery trajectory: a per-pod baseline of 90–130 kg, a
  loss that levels off at 25 kg, and ±1 kg day-to-day variation.

A day is started with `POST /admin/days/<d>`. The mock emits that day's
observation to every pod in pod order, always the same sequence, in waves of
`writeConcurrency` pods: the next wave starts once every event of the previous
wave has been handed to its socket, so at most that many notifications are in
flight. It refuses to push while any pod lacks a weight subscription, since
that event would be lost.
Real Kvasir writes go through its own backend before a notification is sent;
that write path is outside this measurement.

## What is measured

Before day 1 the lab waits for the initial distribution (one observation per
pod) and for all `2 × podCount` subscriptions. Then, for each day, it:

1. requests the push (t0);
2. adds the day to the expected distribution computed from the generator;
3. polls the service's `/metrics` every 50 ms until its distribution holds
   every expected observation; this cheap call sets the timing resolution and
   doubles as the resource sample; and
4. requests `/w-dist` once to confirm the content (retrying every second if it
   does not match yet). `/w-dist` sorts every stored value, so the benchmark
   avoids calling it while the service is still ingesting.

A distribution is correct only when every month bucket matches: the same set of
months, the exact count per month, and each month's mean within 0.011 of the
expected mean (the CSV rounds to two decimals).

Each day record reports:

- `endToEndMs`: from t0 until `/w-dist` was observed to be correct;
- `endToEndLowerBoundMs`: the service cannot have been correct earlier than
  the mock finished pushing, nor before the last `/metrics` poll that still saw
  it incomplete; the true moment lies between this bound and `endToEndMs`;
- `pushMs`, `mockPushMs` and `propagationMs`: time until the mock confirmed the
  push (and its own push duration), and the time from there until correct;
- `distributionRequestMs`: how long the confirming `/w-dist` request took; it
  grows with the data;
- service resources: peak RSS, peak heap, CPU used during the day, and the
  longest event-loop delay, plus the mock's memory.

The startup record reports the time until the initial distribution was correct
and the service's resources since launch. The year record reports `yearWallMs`
(t0 of day 1 until day `days` was correct), the sums of the daily times, the
worst day, and the final observation and triple counts.

`summary.json` contains p50, p90, p95 and p99 estimates with
percentile-bootstrap confidence intervals per day, for startup, and for the
year. Repetitions are the resampling unit and days are never mixed. Days
completed before a failure remain in the per-day statistics, so the sample
count can decline in later days.

### Failure classification

Every failed repetition gets a `kind` that names the process at fault and the
cause, so a service that runs out of memory is never confused with a mock or
benchmark problem:

| `kind` | Meaning |
|---|---|
| `service-heap-out-of-memory` | the service log contains Node's fatal heap-exhaustion error |
| `service-os-out-of-memory` | the service was SIGKILLed and the kernel log shows the OOM killer chose its pid |
| `service-killed` | the service was SIGKILLed without OOM-killer evidence (or the kernel log was unreadable) |
| `service-crashed` | the service exited unexpectedly for any other reason |
| `service-timeout` | the service stayed alive but did not return the correct distribution within 30 minutes |
| `mock-…` | the same causes, for the mock pod server |
| `run-error` | both processes were alive; the benchmark itself failed |

The failure is charged to the process that exited unexpectedly **first**; a
later exit of the other process is treated as a consequence. A process stopped
by the controller (even with a SIGKILL after the shutdown timeout) never counts
as an unexpected exit. Failures during launch, before the benchmark started,
have `stage: "launch"`.

The kernel log is read with `dmesg`, falling back to `journalctl -k`; if neither
is readable, `kernelLogUnavailable` explains why and an OOM-killer SIGKILL stays
classified as `service-killed`. On the VM, make sure the experiment user can
read the kernel log (for example `sudo sysctl kernel.dmesg_restrict=0`, or
membership of the `adm` or `systemd-journal` group).

Each failure records its stage and day, the last fully completed day and triple
count, the pushed triple count when the failure was detected, and the service's
last sampled processed triple count and memory. Under `processes.service` and
`processes.mock` it keeps each process's pid, start and exit times, exit code
or signal, whether the exit was unexpected, heap-OOM evidence (with the time
the controller saw the fatal line and the heap size Node reported), OOM-killer
lines, and the last log lines. The OOM log time is when the controller received
the fatal text, not the exact instant heap exhaustion began.

`summary.json` counts failures per kind in `failureKinds` and lists every
service heap or OS out-of-memory failure in `serviceMemoryFailures`, with the
day it happened and the workload at that point.

## Read-query benchmark

`/w-dist` recomputes mean, standard deviation and quartiles from every stored
value on each request, so its cost grows with the data. The service's
`incremental` distribution strategy maintains the same statistics as
observations arrive (a running sum and variance, and a count per distinct
value for exact quartiles), and returns the same CSV.

```sh
npm --prefix service run build
node --expose-gc bin/latency-lab.js read-benchmark
```

replays the experiment's data (10,000 pods, 365 days) into both strategies in
one process, with no network or query engine, and at day 1, every 30th day
and the last day times `--reads` (10) computations of the CSV per strategy and
checks that both CSVs are equal. Options: `--pods`, `--days`, `--reads`,
`--every`. Results go to `results/read-benchmark-<timestamp>/read-benchmark.ndjson`:
a header (scale and host), one record per checkpoint (read durations, the time
to add that day's observations, whether the CSVs are identical and the largest
difference per column), and a summary. Values that land exactly on a
two-decimal rounding tie can round differently between strategies; such
checkpoints are reported as within rounding rather than identical. The
benchmark holds both strategies' data at once, so longer replays need a larger
heap, for example `--max-old-space-size=16384` for `--days 1825`.

To confirm the result end to end, run the normal experiment with
`"service": { "distribution": "incremental" }` in `config.json` (a few
repetitions suffice), then compare:

```sh
python analysis/ig5_read_comparison.py results/read-benchmark-<timestamp> \
  --lab-recompute results/experiment-<recompute run> \
  --lab-incremental results/experiment-<incremental run>
python analysis/centralized_reference.py results/experiment-<incremental run>
```

## Scale expectations

The dominant cost besides the data is the service's two long-lived SSE streams
per pod: a 10,000-pod run keeps about 20,000 connections open. Raise the
open-file limit on the VM before a full-scale run.

## Run the service as a container

The service also runs as a Docker container:

```sh
docker build -t pacsoi-latency:latest service
docker run --rm --network host \
  -e POD_SERVER_URL=http://127.0.0.1:3001 \
  -e POD_PREFIX=latency \
  -e POD_COUNT=10000 \
  -e SLICE_NAME=pacsoi-latency \
  -e PORT=3000 \
  pacsoi-latency:latest
```

## Tests

`npm run test:all` runs the lab and service tests.
