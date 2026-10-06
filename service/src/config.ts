export type LatencyConfig = {
  podBaseUrls: string[];
  patientSlice: string;
  procedureSlice: string;
  weightSlice: string;
};

function sliceName(variable: string, value: string | undefined): string {
  const normalized = value?.trim().replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new Error(`Environment variable ${variable} must be set`);
  if (normalized.includes("/")) {
    throw new Error(`Environment variable ${variable} must be a slice name, not a path`);
  }
  return normalized;
}

export function parsePodSources(value: string | undefined): string[] {
  if (!value) throw new Error("Environment variable SOURCES must be set");

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Environment variable SOURCES must be a JSON array of pod base URLs");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Environment variable SOURCES must be a non-empty JSON array");
  }

  const sources = parsed.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`SOURCES[${index}] must be a non-empty URL string`);
    }
    let url: URL;
    try {
      url = new URL(entry.trim());
    } catch {
      throw new Error(`SOURCES[${index}] is not a valid URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`SOURCES[${index}] must use http or https`);
    }
    return url.href.replace(/\/+$/, "");
  });

  if (new Set(sources).size !== sources.length) {
    throw new Error("Environment variable SOURCES must not contain duplicate pod URLs");
  }
  return sources;
}

export function readConfig(environment: NodeJS.ProcessEnv = process.env): LatencyConfig {
  return {
    podBaseUrls: parsePodSources(environment.SOURCES),
    patientSlice: sliceName("PATIENT_SLICE", environment.PATIENT_SLICE),
    procedureSlice: sliceName("BAR_PROCEDURE_SLICE", environment.BAR_PROCEDURE_SLICE),
    weightSlice: sliceName("WEIGHT_SLICE", environment.WEIGHT_SLICE),
  };
}
