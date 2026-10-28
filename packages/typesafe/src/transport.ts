import { setTimeout as delay } from "node:timers/promises";
import { assertJson, type JsonValue } from "@tessar/core";
import { TypeSafeAPIError, TypeSafeResponseError } from "./errors.js";

function retryDelay(headers: Headers | undefined, attempt: number): number {
  const milliseconds = headers?.get("retry-after-ms");
  const after = headers?.get("retry-after");
  const value =
    milliseconds != null
      ? Number(milliseconds)
      : after != null
        ? Number.isFinite(Number(after))
          ? Number(after) * 1000
          : Date.parse(after) - Date.now()
        : Number.NaN;
  // Match the provider SDK's bounded Retry-After policy; larger values use backoff.
  return Number.isFinite(value) && value >= 0 && value <= 60_000
    ? value
    : Math.min(500 * 2 ** attempt, 5_000);
}

export async function sendRequest(
  options: {
    url: string;
    headers: Headers;
    body: string;
    timeout: number;
    maxRetries: number;
    signal?: AbortSignal;
  },
  call: { attemptCount: number },
): Promise<{ value: unknown; raw: string }> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(options.timeout);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    let response: Response | undefined;
    try {
      call.attemptCount++;
      response = await fetch(options.url, {
        method: "POST",
        headers: options.headers,
        body: options.body,
        signal,
      });
      const raw = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(raw);
        assertJson(value);
      } catch {
        if (response.ok)
          throw new TypeSafeResponseError(
            "TypeSafe returned invalid JSON",
            raw,
          );
        value = raw;
      }
      if (!response.ok)
        throw new TypeSafeAPIError(
          response.status,
          value as JsonValue,
          response.headers.get("x-request-id") ??
            response.headers.get("request-id"),
        );
      return { value, raw };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (TypeSafeResponseError.isInstance(error)) throw error;
      const retryable = TypeSafeAPIError.isInstance(error)
        ? error.status === 408 ||
          error.status === 429 ||
          (error.status >= 500 && error.status <= 599)
        : timeout.aborted || error instanceof TypeError;
      if (!retryable || attempt >= options.maxRetries) throw error;
      try {
        await delay(retryDelay(response?.headers, attempt), undefined, {
          signal: options.signal,
        });
      } catch (waitError) {
        options.signal?.throwIfAborted();
        throw waitError;
      }
    }
  }
}
