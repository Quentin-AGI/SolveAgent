export class JsonRequestError extends Error {
  constructor(code, options = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = "JsonRequestError";
    this.code = code;
    this.status = options.status;
  }
}

const retryableCodes = new Set([
  "SERVICE_EMPTY_RESPONSE",
  "SERVICE_INVALID_RESPONSE",
  "SERVICE_UNAVAILABLE",
]);

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new JsonRequestError("SERVICE_EMPTY_RESPONSE", {
      status: response.status,
    });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new JsonRequestError("SERVICE_INVALID_RESPONSE", {
      status: response.status,
      cause: error,
    });
  }

  if (!response.ok) {
    throw new JsonRequestError(
      typeof body?.error === "string" ? body.error : "REQUEST_FAILED",
      { status: response.status },
    );
  }
  return body;
}

const defaultSleep = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

export async function requestJson(url, options, runtime = {}) {
  const fetchImpl = runtime.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const sleep = runtime.sleep ?? defaultSleep;
  const maxAttempts = runtime.maxAttempts ?? 2;
  const retryDelayMs = runtime.retryDelayMs ?? 300;
  if (typeof fetchImpl !== "function") {
    throw new JsonRequestError("SERVICE_UNAVAILABLE");
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readJsonResponse(await fetchImpl(url, options));
    } catch (error) {
      lastError =
        error instanceof JsonRequestError
          ? error
          : new JsonRequestError("SERVICE_UNAVAILABLE", { cause: error });
      if (attempt >= maxAttempts || !retryableCodes.has(lastError.code)) {
        throw lastError;
      }
      await sleep(retryDelayMs);
    }
  }

  throw lastError ?? new JsonRequestError("SERVICE_UNAVAILABLE");
}
