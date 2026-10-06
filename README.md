# PACSOI IG5 latency lab

This repository measures how long new bariatric-procedure and weight-observation data in Kvasir personal data pods takes to appear in the PACSOI service's complete weight distribution.

This repository owns both the experiment harness and its standalone
`pacsoi-latency` service image. The separate `aggregator` project only carries
the unprofiled deployment definition that maps the experiment's RDF input to
the container.

## Configuration

Requires Node.js 20 or newer. Copy the example configuration and fill four external connection values:

```sh
cp config.example.json config.json
```

- `kvasir.serverUrl`
- `kvasir.clientId`
- `kvasir.clientSecret`
- `aggregator.serverUrl`

The configured Kvasir client pair is retained as the Kvasir environment/setup credential. It is not installed as a pod's generated administrative client. The harness discovers the OIDC token endpoint from Kvasir's Bearer challenge, so Keycloak-specific URLs are not configuration inputs.

Pod IDs and owner usernames are identical. With the example configuration they are `latency001`, `latency002`, `latency003`, and so on. Kvasir initially uses the owner username as its password, although a production Keycloak configuration can require changing that password on first login. Each pod also gets a separate lowercase OAuth client whose ID and secret are both `<podId>client`; for example, `latency001client` / `latency001client`. Lowercase is intentional because Keycloak normalizes service-account usernames to lowercase and Kvasir's ReBAC principal must match exactly. Slice registration, ReBAC setup, and benchmark writes use the client-credentials grant, so they do not depend on completion of the owner's interactive first-login actions. Change `experiment.podPrefix` to select another shared pod/user prefix.

The Aggregator server must allow the `none` registration flow. No UMA integration is used. Slice reads are made public by assigning `reader` on both the slice root and its `/query` resource to `urn:kvasir-user:anonymous`; setup and mutations continue to use the per-pod Kvasir client credentials.

## Workflow

```sh
npm test
node bin/latency-lab.js pods provision
node bin/latency-lab.js slices setup
node bin/latency-lab.js aggregator register
node bin/latency-lab.js service deploy
node bin/latency-lab.js doctor
node bin/latency-lab.js run
```

To permanently remove every pod in the configured experiment inventory:

```sh
node bin/latency-lab.js pods cleanup --confirm
```

Cleanup is deliberately excluded from the normal workflow and requires the explicit confirmation flag. It first uses the current lowercase service client. For migration purposes it can fall back to owner-password authentication with both the current lowercase `<podId>client` and earlier mixed-case `<podId>Client` credentials. If the owner password has been changed, delete the legacy pod through Kvasir's UI instead.

Runtime state is stored under `state/` with mode `0600`, and experiment records are appended as NDJSON under `results/`. Both are ignored by Git.

Pod and access setup operations are repeatable: existing pods and slices (`409 Conflict`) are accepted, while RDF and ReBAC inserts are safe to repeat. For a clean latency run, remove and recreate the pods and service because the benchmark deliberately refuses a non-empty initial weight distribution.

An existing pod cannot have its owner identity repaired by another create request. If a pod was originally created with the wrong owner, delete and recreate that test pod, or choose a new `experiment.podPrefix` before provisioning. The CLI reports this explicitly when Kvasir returns `409 Conflict`.

The same restriction applies to generated administrative clients and their ReBAC tuples. After changing the pod identity or client naming convention, the old test pod must be deleted and recreated. A successful replacement reports `"created": true`; `"created": false` means Kvasir kept the old pod configuration.

## PACSOI data model and experiment

Every pod receives one combined slice containing the patient, bariatric-procedure, and weight-observation views consumed by `service/`. Slice setup inserts one patient identity per pod, but no procedures or weights. The service receives the complete pod inventory directly in its deployment parameters; no pod acts as a registry.

After the PACSOI service starts with an empty CSV distribution, each measured round:

1. adds the fixed bariatric procedure on the first round;
2. adds a random 1–5 weight observations to every pod;
3. calculates the exact cumulative count and average expected in `/w-dist`;
4. polls the CSV until both values match; and
5. appends the write timings, expected values, output snapshot, end-to-end latency, and post-acceptance propagation latency to NDJSON.

All generated observations are in the same relative calendar month, making the completion condition unambiguous. Later rounds retain prior data and add more observations, so the output measures increasing dataset sizes.

## Service and Aggregator contract

The standalone implementation lives under `service/`. The Aggregator project
publishes an unprofiled `pacsoi-latency` deployment function with this contract:

- a required `sources` parameter of type `xsd:string` must be bound directly to `SOURCES`; its value is a JSON array containing all N pod base URLs;
- the service must parse `SOURCES` and attach `<podBaseUrl>/slices/<combinedSliceName>/query` as the patient, procedure, and weight source for every supplied pod;
- `PATIENT_SLICE`, `WEIGHT_SLICE`, and `BAR_PROCEDURE_SLICE` must all use the configured combined slice name (`pacsoi-latency` by default);
- the latency variant should initialize only the patient, bariatric-procedure, and weight streams rather than requiring the unrelated knee/Oxford slices;
- the service must remain directly readable without UMA; and
- the weight distribution must remain available at `/w-dist` with the existing CSV columns.

The container is published as `ghcr.io/ponachte/pacsoi-latency`. The Aggregator
definition selects that image when an experiment deploys its service.

## Current boundary

This foundation intentionally omits UMA, plots, dashboards, and concurrent
experiments. Raw round data is preserved so reporting can be added independently.
