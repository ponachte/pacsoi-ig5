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

function causeDetails(error, depth = 0) {
  if (!(error instanceof Error) || depth >= 5) return undefined;
  const details = {
    name: error.name,
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.errno === undefined ? {} : { errno: error.errno }),
    ...(error.syscall === undefined ? {} : { syscall: error.syscall }),
    ...(error.address === undefined ? {} : { address: error.address }),
    ...(error.port === undefined ? {} : { port: error.port }),
  };
  const cause = causeDetails(error.cause, depth + 1);
  if (cause) details.cause = cause;
  return details;
}

export function errorDetails(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    ...causeDetails(error),
    ...(error.request === undefined ? {} : { request: error.request }),
  };
}

export async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 30_000, operation = "HTTP request") {
  const controller = new AbortController();
  const started = performance.now();
  const requestStartedAt = new Date().toISOString();
  const requestId = new Headers(options.headers).get("x-experiment-request-id");
  let timedOut = false;
  let responseReceived = false;
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
  const normalizeError = (error, phase) => {
    const elapsedMs = performance.now() - started;
    const outcome = timedOut ? "timeout" : upstream?.aborted ? "aborted" : "network-error";
    const failedAt = new Date().toISOString();
    const message = timedOut
      ? `${operation} timed out after ${timeoutMs}ms (${url})`
      : upstream?.aborted
        ? `${operation} aborted after ${elapsedMs.toFixed(1)}ms (${url})`
        : `${operation} failed after ${elapsedMs.toFixed(1)}ms (${url}): ${error.message}`;
    const wrapped = new Error(message, { cause: error });
    wrapped.name = timedOut ? "TimeoutError" : "FetchError";
    wrapped.request = {
      operation,
      url,
      method: options.method ?? "GET",
      ...(requestId ? { requestId } : {}),
      requestStartedAt,
      failedAt,
      timeoutMs,
      elapsedMs,
      phase,
      outcome,
    };
    return wrapped;
  };
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    responseReceived = true;
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
          try { return await original(...args); } catch (error) {
            throw normalizeError(error, "response-body");
          } finally { cleanup(); }
        },
      });
    }
    return response;
  } catch (error) {
    cleanup();
    throw normalizeError(error, responseReceived ? "response-body" : "response");
  }
}
