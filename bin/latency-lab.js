#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { deletePods, provisionPods } from "../src/kvasir/pods.js";
import { setupSlices } from "../src/kvasir/slices.js";
import { registerAggregator, deployService } from "../src/aggregator/client.js";
import { runExperiment } from "../src/benchmark/runner.js";
import { doctor } from "../src/doctor.js";

const help = `Usage: latency-lab <command>

Commands:
  pods provision       Create the configured number of pods
  pods cleanup --confirm
                       Permanently delete all configured test pods
  slices setup         Register combined PACSOI slices and seed source topology
  aggregator register Register an aggregator using the none flow
  service deploy       Deploy the configured PACSOI Aggregator service
  doctor               Check servers and anonymous slice access
  run                  Run the configured number of measurements
  help                  Show this help
`;

async function main() {
  const command = process.argv.slice(2).join(" ") || "help";
  if (command === "help" || command === "--help" || command === "-h") return console.log(help);
  const config = await loadConfig();
  if (command === "pods provision") console.log(JSON.stringify(await provisionPods(config), null, 2));
  else if (command === "pods cleanup") throw new Error("Pod cleanup is destructive; rerun with `pods cleanup --confirm`.");
  else if (command === "pods cleanup --confirm") console.log(JSON.stringify(await deletePods(config), null, 2));
  else if (command === "slices setup") { await setupSlices(config); console.log("Slices are anonymously readable."); }
  else if (command === "aggregator register") console.log(JSON.stringify(await registerAggregator(config), null, 2));
  else if (command === "service deploy") console.log(JSON.stringify(await deployService(config), null, 2));
  else if (command === "doctor") { await doctor(config); console.log("All checks passed."); }
  else if (command === "run") console.log(`Results: ${await runExperiment(config)}`);
  else throw new Error(`Unknown command: ${command}\n\n${help}`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
