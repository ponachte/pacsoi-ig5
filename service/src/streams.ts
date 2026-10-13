import { isAddition, QuerySourceIterator } from "@incremunica/user-tools";
import { Mutex } from "async-mutex";
import { WeightDistribution } from "./distribution.js";
import * as Schemas from "./schemas.js";

type ServiceVersion = "memory" | "level";

type Source = {
  value: string;
  type: "graphql";
  context: { schema: string; context: typeof Schemas.CONTEXT };
};

function source(baseUrl: string, slice: string, schema: string): Source {
  return {
    value: `${baseUrl}/slices/${encodeURIComponent(slice)}/query`,
    type: "graphql",
    context: { schema, context: Schemas.CONTEXT },
  };
}

export function attachPodSources(
  podBaseUrls: string[],
  slices: { procedure: string; weight: string },
  procedures: QuerySourceIterator,
  weights: QuerySourceIterator,
) {
  for (const baseUrl of podBaseUrls) {
    procedures.addSource(source(baseUrl, slices.procedure, Schemas.PROCEDURE_SCHEMA));
    weights.addSource(source(baseUrl, slices.weight, Schemas.WEIGHT_SCHEMA));
  }
}

export async function createQueryEngine(version: ServiceVersion) {
  if (version === "level") {
    const { QueryEngine } = await import("@incremunica-level/query-sparql-incremental-level");
    return new QueryEngine();
  }
  const { QueryEngine } = await import("@incremunica/query-sparql-incremental");
  return new QueryEngine();
}

async function bindings(query: string, sources: QuerySourceIterator, version: ServiceVersion) {
  const engine = await createQueryEngine(version);
  return engine.queryBindings(query, {
    sources: [{ value: sources, type: "stream-graphql" } as any],
  });
}

export async function startStreams(
  procedures: QuerySourceIterator,
  weights: QuerySourceIterator,
  distribution: WeightDistribution,
  mutex: Mutex,
  version: ServiceVersion,
) {
  const [procedureStream, weightStream] = await Promise.all([
    bindings(Schemas.PROCEDURE_QUERY, procedures, version),
    bindings(Schemas.WEIGHT_QUERY, weights, version),
  ]);

  procedureStream.on("data", async (binding) => {
    if (isAddition(binding) && binding.has("patient") && binding.has("timestamp")) {
      await mutex.runExclusive(() => distribution.addProcedure(
        binding.get("patient").value,
        new Date(binding.get("timestamp").value),
      ));
    }
  });
  weightStream.on("data", async (binding) => {
    if (isAddition(binding) && binding.has("patient") && binding.has("value") && binding.has("timestamp")) {
      await mutex.runExclusive(() => distribution.addObservation(
        binding.get("patient").value,
        Number(binding.get("value").value),
        new Date(binding.get("timestamp").value),
      ));
    }
  });

  for (const [name, stream] of [
    ["procedure", procedureStream],
    ["weight", weightStream],
  ] as const) {
    stream.on("error", (error) => console.error(`[${name}] stream error`, error));
  }
}
