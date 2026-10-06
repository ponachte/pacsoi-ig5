import assert from "node:assert/strict";
import test from "node:test";
import { QuerySourceIterator } from "@incremunica/user-tools";
import { attachPodSources } from "../dist/streams.js";

test("attaches each combined slice to all three stream views", () => {
  const patients = new QuerySourceIterator();
  const procedures = new QuerySourceIterator();
  const weights = new QuerySourceIterator();

  attachPodSources(
    ["https://kvasir.example/latency001"],
    {
      patient: "pacsoi-latency",
      procedure: "pacsoi-latency",
      weight: "pacsoi-latency",
    },
    patients,
    procedures,
    weights,
  );

  for (const iterator of [patients, procedures, weights]) {
    const item = iterator.read();
    assert.equal(item.isAddition, true);
    assert.equal(
      item.querySource.value,
      "https://kvasir.example/latency001/slices/pacsoi-latency/query",
    );
    assert.equal(item.querySource.type, "graphql");
    assert.match(item.querySource.context.schema, /type Query/);
    iterator.destroy();
  }
});
