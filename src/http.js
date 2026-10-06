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

