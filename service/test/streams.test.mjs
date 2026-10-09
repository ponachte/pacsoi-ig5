import assert from "node:assert/strict";
import test from "node:test";
import { QuerySourceIterator } from "@incremunica/user-tools";
import { attachPodSources } from "../dist/streams.js";

test("attaches each combined slice to the procedure and weight stream views", () => {
  const procedures = new QuerySourceIterator();
  const weights = new QuerySourceIterator();

  attachPodSources(
    ["http://mock.example/latency001"],
    {
      procedure: "pacsoi-latency",
      weight: "pacsoi-latency",
    },
    procedures,
    weights,
  );

  for (const iterator of [procedures, weights]) {
    const item = iterator.read();
    assert.equal(item.isAddition, true);
    assert.equal(
      item.querySource.value,
      "http://mock.example/latency001/slices/pacsoi-latency/query",
    );
    assert.equal(item.querySource.type, "graphql");
    assert.match(item.querySource.context.schema, /type Query/);
    iterator.destroy();
  }
});
