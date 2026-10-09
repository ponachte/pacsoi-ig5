export function podIds({ podPrefix, podCount }) {
  const width = Math.max(3, String(podCount).length);
  return Array.from({ length: podCount }, (_, index) => `${podPrefix}${String(index + 1).padStart(width, "0")}`);
}

export function podUrl(config, podId) {
  return `${config.mock.serverUrl}/${encodeURIComponent(podId)}`;
}

export function sliceUrl(config, podId) {
  return `${podUrl(config, podId)}/slices/${encodeURIComponent(config.experiment.sliceName)}`;
}

export function queryUrl(config, podId) { return `${sliceUrl(config, podId)}/query`; }
