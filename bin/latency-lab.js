#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { resetMock } from "../src/mock/client.js";
import { runExperiment } from "../src/benchmark/runner.js";
import { check } from "../src/check.js";
import { generateRunReport } from "../src/report.js";
import { runFullExperiment } from "../src/benchmark/full-experiment.js";

const help = `Usage: latency-lab <command>

Commands:
  mock reset   Reset virtual pods and seed their initial procedure/weight data
  check        Check mock configuration and standalone service health
  run          Push round changes, validate full results, and record latency/resources
  experiment   Build and manage mock/service processes, repeat the run, and aggregate statistics
  report FILE [--error FILE] [--output FILE]
               Generate a self-contained HTML report for one run
  help         Show this help
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args.join(" ") || "help";
  if (["help", "--help", "-h"].includes(command)) return console.log(help);
  if (args[0] === "report") {
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
  const config = await loadConfig();
  if (command === "mock reset") console.log(JSON.stringify(await resetMock(config), null, 2));
  else if (command === "check") console.log(JSON.stringify(await check(config), null, 2));
  else if (command === "run") console.log(`Results: ${await runExperiment(config)}`);
  else if (["experiment", "full"].includes(command)) {
    const result = await runFullExperiment(config);
    console.log(`Experiment summary: ${result.output}`);
    console.log(`Experiment report: ${result.report}`);
  }
  else throw new Error(`Unknown command: ${command}\n\n${help}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
