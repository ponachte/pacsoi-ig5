#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { generateRunReport } from "../src/report.js";
import { runFullExperiment } from "../src/benchmark/full-experiment.js";
import { DEFAULT_READ_BENCHMARK, runReadBenchmark } from "../src/benchmark/read-benchmark.js";

const help = `Usage: latency-lab <command>

Commands:
  experiment   Build the service, then for every repetition start a fresh mock
               and service, run all days, and aggregate the statistics
  read-benchmark [--pods N] [--days N] [--reads N] [--every N]
               Replay the scenario into both /w-dist strategies (recompute and
               incremental) in one process and time the read at every N-th day;
               build the service first (npm --prefix service run build)
  report FILE [--error FILE] [--output FILE]
               Generate a self-contained HTML report for one repetition file
  help         Show this help
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) return console.log(help);
  if (command === "report") {
    if (!args[1] || args[1].startsWith("--")) throw new Error("report requires an NDJSON run file");
    const option = (name) => {
      const index = args.indexOf(name);
      if (index < 0) return undefined;
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a file`);
      return args[index + 1];
    };
    const report = await generateRunReport(args[1], { errorFile: option("--error"), output: option("--output") });
    return console.log(`Report: ${report.output}`);
  }
  if (command === "experiment" && args.length === 1) {
    const result = await runFullExperiment(await loadConfig());
    console.log(`Experiment summary: ${result.output}`);
    console.log(`Experiment report: ${result.report}`);
    return undefined;
  }
  if (command === "read-benchmark") {
    const flags = { "--pods": "podCount", "--days": "days", "--reads": "reads", "--every": "every" };
    const options = { ...DEFAULT_READ_BENCHMARK };
    for (let index = 1; index < args.length; index += 2) {
      const key = flags[args[index]];
      const value = Number(args[index + 1]);
      if (!key) throw new Error(`Unknown read-benchmark option: ${args[index]}`);
      if (!Number.isInteger(value) || value <= 0) throw new Error(`${args[index]} must be a positive integer`);
      options[key] = value;
    }
    const result = await runReadBenchmark(options);
    console.log(`Read benchmark: ${result.output}`);
    if (!result.allWithinRounding) {
      console.error("The two strategies returned different results; see the checkpoint records");
      process.exitCode = 1;
    } else if (!result.allIdentical) {
      console.log("Some checkpoints differ by one rounding step (0.01); see maxDifference in the records");
    }
    return undefined;
  }
  throw new Error(`Unknown command: ${args.join(" ")}\n\n${help}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
