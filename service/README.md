# PACSOI latency service

This is the standalone, weight-only service used by the `pacsoi-ig5` latency
lab. It is intentionally separate from `pacsoi-service`.

`SOURCES` must contain a JSON array of Kvasir pod base URLs. For each pod, the
service attaches `<pod>/slices/<slice>/query` to three incremental views:
patients, bariatric procedures, and weight observations. The lab uses one
combined slice named `pacsoi-latency` for all three views.

Required environment variables:

| Variable | Value |
| --- | --- |
| `SOURCES` | JSON array of pod base URLs |
| `PATIENT_SLICE` | Combined slice name |
| `BAR_PROCEDURE_SLICE` | Combined slice name |
| `WEIGHT_SLICE` | Combined slice name |

The anonymous `GET /w-dist` endpoint returns
`month,avg_weight,stdev,q25,q75,count` CSV. The service has no HCP discovery,
Oxford/knee streams, or UMA dependency.

Build the standalone image from the repository root with:

```sh
make image-build
```

Run its tests independently with:

```sh
make service-test
```

The GitHub Actions workflow publishes `ghcr.io/ponachte/pacsoi-latency`
for pushes to `main`, version tags, and manual runs. Pull requests build and test
the image without publishing it. The package includes an OCI source label linking
it to this repository. The Aggregator's unprofiled
deployment definition publishes `/deployments/pacsoi-latency#sources` with
datatype `xsd:string`; the lab sends the JSON source array as that predicate's
literal value.

The Slices cluster can pull this image anonymously when the GHCR package is
public. If the repository or package remains private, configure an
`imagePullSecret` in the Aggregator namespace before deploying the service.
