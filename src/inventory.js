export function podIds({ podPrefix, podCount }) {
  const width = Math.max(3, String(podCount).length);
  return Array.from({ length: podCount }, (_, index) => `${podPrefix}${String(index + 1).padStart(width, "0")}`);
}

export function podIdentities(settings) {
  return podIds(settings).map((podId) => ({
    podId,
    username: podId,
    adminClientId: `${podId}client`,
    adminClientSecret: `${podId}client`,
  }));
}

export function podAdminCredentials(podId) {
  const value = `${podId}client`;
  return { clientId: value, clientSecret: value };
}

export function podUrl(config, podId) {
  return `${config.kvasir.serverUrl}/${encodeURIComponent(podId)}`;
}

export function sliceUrl(config, podId) {
  return `${podUrl(config, podId)}/slices/${encodeURIComponent(config.experiment.sliceName)}`;
}

export function queryUrl(config, podId) {
  return `${sliceUrl(config, podId)}/query`;
}
