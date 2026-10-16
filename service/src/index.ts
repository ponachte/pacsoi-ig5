import { QuerySourceIterator } from "@incremunica/user-tools";
import { Mutex } from "async-mutex";
import Fastify from "fastify";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { readConfig } from "./config.js";
import { WeightDistribution } from "./distribution.js";
import { attachPodSources, startStreams } from "./streams.js";

async function main() {
  const config = readConfig();
  const procedures = new QuerySourceIterator({ distinct: true });
  const weights = new QuerySourceIterator({ distinct: true });
  const distribution = new WeightDistribution(config.distribution);
  const mutex = new Mutex();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();

  await startStreams(procedures, weights, distribution, mutex, config.serviceVersion);
  attachPodSources(
    config.podBaseUrls,
    {
      procedure: config.sliceName,
      weight: config.sliceName,
    },
    procedures,
    weights,
  );
  console.log(
    `[MAIN] Attached ${config.podBaseUrls.length} PACSOI latency pod source(s); distribution=${config.distribution}`,
  );

  const app = Fastify();
  app.get("/health", async () => ({
    status: "ok",
    podCount: config.podBaseUrls.length,
    serviceVersion: config.serviceVersion,
    distributionStrategy: config.distribution,
  }));
  app.get("/metrics", async () => {
    const cpu = process.cpuUsage();
    const resource = process.resourceUsage();
    const eventLoopMetrics = {
      meanMs: Number(eventLoop.mean) / 1e6,
      p95Ms: Number(eventLoop.percentile(95)) / 1e6,
      maxMs: Number(eventLoop.max) / 1e6,
    };
    eventLoop.reset();
    return {
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      podCount: config.podBaseUrls.length,
      serviceVersion: config.serviceVersion,
      distributionStrategy: config.distribution,
      process: {
        ...process.memoryUsage(),
        maxRssBytes: resource.maxRSS * 1024,
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
      },
      eventLoop: eventLoopMetrics,
      distribution: await mutex.runExclusive(() => distribution.stats()),
    };
  });
  app.get("/w-dist", async (_request, reply) => {
    const csv = await mutex.runExclusive(() => distribution.toCSV());
    return reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", "attachment; filename=dist.csv")
      .send(csv);
  });
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
