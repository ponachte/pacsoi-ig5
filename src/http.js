export async function responseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

export async function expectResponse(response, expected, operation) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  const body = await responseBody(response);
  if (!accepted.includes(response.status)) {
    const detail = body === undefined ? "" : `: ${typeof body === "string" ? body : JSON.stringify(body)}`;
    throw new Error(`${operation} failed with ${response.status} ${response.statusText}${detail}`);
  }
  return body;
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 30_000, operation = "HTTP request") {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${operation} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const upstream = options.signal;
  const abortFromUpstream = () => controller.abort(upstream.reason);
  if (upstream) upstream.addEventListener("abort", abortFromUpstream, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener("abort", abortFromUpstream);
  };
  const normalizeError = (error) => {
    if (timedOut) return new Error(`${operation} timed out after ${timeoutMs}ms`, { cause: error });
    return error;
  };
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    if (response.body === null) {
      cleanup();
      return response;
    }
    for (const method of ["text", "json", "arrayBuffer", "blob", "formData"]) {
      if (typeof response[method] !== "function") continue;
      const original = response[method].bind(response);
      Object.defineProperty(response, method, {
        configurable: true,
        value: async (...args) => {
          try { return await original(...args); } catch (error) { throw normalizeError(error); } finally { cleanup(); }
        },
      });
    }
    return response;
  } catch (error) {
    cleanup();
    throw normalizeError(error);
  }
}

