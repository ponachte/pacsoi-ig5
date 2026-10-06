import { QuerySourceIterator } from "@incremunica/user-tools";
import { Mutex } from "async-mutex";
import Fastify from "fastify";
import { readConfig } from "./config.js";
import { WeightDistribution } from "./distribution.js";
import { attachPodSources, startStreams } from "./streams.js";

async function main() {
  const config = readConfig();
  const patients = new QuerySourceIterator({ distinct: true });
  const procedures = new QuerySourceIterator({ distinct: true });
  const weights = new QuerySourceIterator({ distinct: true });
  const distribution = new WeightDistribution();
  const mutex = new Mutex();

  await startStreams(patients, procedures, weights, distribution, mutex);
  attachPodSources(
    config.podBaseUrls,
    {
      patient: config.patientSlice,
      procedure: config.procedureSlice,
      weight: config.weightSlice,
    },
    patients,
    procedures,
    weights,
  );
  console.log(`[MAIN] Attached ${config.podBaseUrls.length} PACSOI latency pod source(s)`);

  const app = Fastify();
  app.get("/w-dist", async (_request, reply) => {
    const csv = await mutex.runExclusive(() => distribution.toCSV());
    return reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", "attachment; filename=dist.csv")
      .send(csv);
  });
  await app.listen({ port: 3000, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
