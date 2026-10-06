import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.js";

const stateDirectory = path.join(projectRoot, "state");

export async function readState(name, fallback = undefined) {
  try { return JSON.parse(await fs.readFile(path.join(stateDirectory, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function writeState(name, value) {
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(path.join(stateDirectory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

