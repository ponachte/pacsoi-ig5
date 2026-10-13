# PACSOI standalone latency service

This container reads the virtual pod server directly. It does not require an
Aggregator deployment or an external Kvasir instance.

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `POD_SERVER_URL` | yes | Base URL reachable from the service |
| `POD_COUNT` | yes | Number of virtual pods |
| `POD_PREFIX` | no | Pod prefix; defaults to `latency` |
| `SLICE_NAME` | no | Combined slice name; defaults to `pacsoi-latency` |
| `SERVICE_VERSION` | no | Query engine: `memory` (default) or `level` |
| `PORT` | no | HTTP port; defaults to `3000` |

The service constructs pod URLs internally, so 10,000 URLs do not have to fit
inside one environment variable. It exposes:

- `GET /health` for liveness;
- `GET /metrics` for memory, CPU, event-loop, and distribution state; and
- `GET /w-dist` for the complete CSV weight distribution.

`memory` uses `@incremunica/query-sparql-incremental`. `level` uses
`@incremunica-level/query-sparql-incremental-level`, which keeps selected
incremental engine state in temporary LevelDB stores. The selected version is
reported by `/health` and `/metrics`.

Build with `docker build -t pacsoi-latency:latest service` and test with
`npm --prefix service test`.
