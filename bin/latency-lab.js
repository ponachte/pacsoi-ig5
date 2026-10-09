#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { resetMock } from "../src/mock/client.js";
import { runExperiment } from "../src/benchmark/runner.js";
import { check } from "../src/check.js";

const help = `Usage: latency-lab <command>

Commands:
  mock reset   Reset virtual pods and seed their initial procedure/weight data
  check        Check mock configuration and standalone service health
  run          Push round changes, validate full results, and record latency/resources
  help         Show this help
`;

async function main() {
  const command = process.argv.slice(2).join(" ") || "help";
  if (["help", "--help", "-h"].includes(command)) return console.log(help);
  const config = await loadConfig();
  if (command === "mock reset") console.log(JSON.stringify(await resetMock(config), null, 2));
  else if (command === "check") console.log(JSON.stringify(await check(config), null, 2));
  else if (command === "run") console.log(`Results: ${await runExperiment(config)}`);
  else throw new Error(`Unknown command: ${command}\n\n${help}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
