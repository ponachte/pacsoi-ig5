#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { generateRunReport } from "../src/report.js";
import { runFullExperiment } from "../src/benchmark/full-experiment.js";

const help = `Usage: latency-lab <command>

Commands:
  experiment   Build the service, then for every repetition start a fresh mock
               and service, run all days, and aggregate the statistics
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
  throw new Error(`Unknown command: ${args.join(" ")}\n\n${help}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
