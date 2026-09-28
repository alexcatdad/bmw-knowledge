import { CollectionError } from "./errors.js";

export async function withAbort<T>(promise: Promise<T>, signal: AbortSignal, code: string, message: string): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw new CollectionError(code, message);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new CollectionError(code, message));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

export async function readResponseBytes(response: Response, maxBytes: number, signal: AbortSignal, timeoutCode: string): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal, timeoutCode, "The response did not complete before its deadline.");
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        throw new CollectionError("RESPONSE_TOO_LARGE", "The response exceeds the configured byte limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
