export type LatencyConfig = {
  podBaseUrls: string[];
  sliceName: string;
  port: number;
};

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} must be set`);
  return value;
}

function positiveInteger(value: string | undefined, name: string, fallback?: number): number {
  const parsed = value === undefined && fallback !== undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Environment variable ${name} must be a positive integer`);
  return parsed;
}

export function buildPodSources(serverUrl: string, prefix: string, count: number): string[] {
  let base: URL;
  try { base = new URL(serverUrl); } catch { throw new Error("Environment variable POD_SERVER_URL must be an absolute URL"); }
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("POD_SERVER_URL must use HTTP or HTTPS");
  const normalized = base.href.replace(/\/$/, "");
  const width = Math.max(3, String(count).length);
  return Array.from({ length: count }, (_, index) =>
    `${normalized}/${encodeURIComponent(`${prefix}${String(index + 1).padStart(width, "0")}`)}`
  );
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): LatencyConfig {
  const count = positiveInteger(environment.POD_COUNT, "POD_COUNT");
  const sliceName = environment.SLICE_NAME?.trim().replace(/^\/+|\/+$/g, "") || "pacsoi-latency";
  if (sliceName.includes("/")) throw new Error("SLICE_NAME must be a name, not a path");
  return {
    podBaseUrls: buildPodSources(
      required(environment, "POD_SERVER_URL"),
      environment.POD_PREFIX?.trim() || "latency",
      count,
    ),
    sliceName,
    port: positiveInteger(environment.PORT, "PORT", 3000),
  };
}
