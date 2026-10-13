// The benchmark runs one fixed scenario: every pod holds one bariatric
// procedure and one weight observation, then receives one new weight
// observation per day. Only the scale (pods, days), the engine under test and
// the number of repetitions are configurable; everything that could make two
// runs of the same scale differ is fixed here.
export const POD_PREFIX = "latency";
export const SLICE_NAME = "pacsoi-latency";

export const DEFAULT_POD_COUNT = 10_000;
export const DEFAULT_DAYS = 365;
export const DEFAULT_REPETITIONS = 50;
// Pods notified per wave when the mock pushes a day.
export const DEFAULT_WRITE_CONCURRENCY = 100;

// The service's /metrics is cheap and reports how many observations its
// distribution holds, so it is polled often: it sets the timing resolution and
// provides the resource samples. /w-dist sorts every stored value; it is only
// requested once the count is complete, and retried at the slower interval if
// its content does not match yet.
export const METRICS_POLL_INTERVAL_MS = 50;
export const DISTRIBUTION_POLL_INTERVAL_MS = 1_000;
export const PROGRESS_INTERVAL_MS = 30_000;

export const REQUEST_TIMEOUT_MS = 60_000;
// Limits for the service to load the initial pods and to absorb one day.
export const STARTUP_TIMEOUT_MS = 1_800_000;
export const DAY_TIMEOUT_MS = 1_800_000;
export const SHUTDOWN_TIMEOUT_MS = 30_000;

export const BOOTSTRAP = { iterations: 10_000, confidenceLevel: 0.95, seed: 20_261_012 };
