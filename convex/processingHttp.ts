import { manifestPathForCapture } from "@bmw-knowledge/collection/policy";
import {
  canonicalCaptureManifestText,
  MAX_PROCESSING_MANIFEST_BYTES,
  processingManifestPathForCapture,
  processingManifestText,
  PROCESSING_FAILURE_CODES,
  validateProcessingManifest,
  type ProcessingManifest,
} from "@bmw-knowledge/normalization/contract";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, httpAction } from "./_generated/server";
import { corpusTarget } from "./corpus";
import { sha256, utf8 } from "./digests";

type FailureCode = (typeof PROCESSING_FAILURE_CODES)[number];
type Publication = { owner: string; repo: string; commitSha: string };
type Callback =
  | { status: "succeeded"; manifest: ProcessingManifest; publication: Publication }
  | { status: "failed"; captureId: string; inputSha256: string; processorRevision: string; code: FailureCode };

const FETCH_TIMEOUT_MS = 10_000;

class CallbackError extends Error {
  constructor(readonly code: string, readonly status: number, readonly failureCode?: FailureCode) {
    super(code);
  }
}

function json(status: number, value: Record<string, unknown>): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function authorized(header: string | null): boolean {
  const configured = env.PROCESSING_CALLBACK_SECRET;
  if (!configured || !header || header.length > 2048 || !header.startsWith("Bearer ")) return false;
  const expected = utf8(configured);
  if (expected.length < 32 || expected.length > 512) return false;
  const supplied = utf8(header.slice("Bearer ".length));
  let difference = expected.length ^ supplied.length;
  // Always inspect every configured secret byte, regardless of mismatch offset.
  for (let index = 0; index < expected.length; index++) difference |= (expected[index] ?? 0) ^ (supplied[index] ?? 0);
  return difference === 0;
}

function exactKeys(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CallbackError("INVALID_BODY", 400);
  return value as Record<string, unknown>;
}

function parseCallback(value: unknown): Callback {
  const body = object(value);
  if (body.status === "succeeded" && exactKeys(body, ["status", "manifest", "publication"])) {
    let manifest: ProcessingManifest;
    try { manifest = validateProcessingManifest(body.manifest); } catch { throw new CallbackError("INVALID_BODY", 400); }
    const publication = object(body.publication);
    if (!exactKeys(publication, ["owner", "repo", "commitSha"]) || typeof publication.owner !== "string" || typeof publication.repo !== "string" || typeof publication.commitSha !== "string" || !/^[a-f0-9]{40}$/.test(publication.commitSha)) {
      throw new CallbackError("INVALID_BODY", 400);
    }
    const target = corpusTarget();
    if (publication.owner !== target.owner || publication.repo !== target.repo) throw new CallbackError("INVALID_PUBLICATION_TARGET", 400);
    return { status: "succeeded", manifest, publication: { owner: publication.owner, repo: publication.repo, commitSha: publication.commitSha } };
  }
  if (body.status === "failed" && exactKeys(body, ["status", "captureId", "inputSha256", "processorRevision", "code"])) {
    if (typeof body.captureId !== "string" || typeof body.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.inputSha256) || typeof body.processorRevision !== "string" || !/^[a-f0-9]{40}$/.test(body.processorRevision)) {
      throw new CallbackError("INVALID_BODY", 400);
    }
    try { manifestPathForCapture(body.captureId); } catch { throw new CallbackError("INVALID_BODY", 400); }
    const code = PROCESSING_FAILURE_CODES.find((candidate) => candidate === body.code);
    if (!code) throw new CallbackError("INVALID_BODY", 400);
    return { status: "failed", captureId: body.captureId, inputSha256: body.inputSha256, processorRevision: body.processorRevision, code };
  }
  throw new CallbackError("INVALID_BODY", 400);
}

async function boundedBytes(body: ReadableStream<Uint8Array> | null, maximum: number, error: CallbackError): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw error;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function corpusFile(publication: Publication, path: string, maximum: number, failureCode: FailureCode): Promise<Uint8Array<ArrayBuffer>> {
  const target = corpusTarget();
  if (publication.owner !== target.owner || publication.repo !== target.repo || !/^[a-f0-9]{40}$/.test(publication.commitSha)) throw new CallbackError("INVALID_PUBLICATION_TARGET", 400);
  // Both revisions and each path have already been generated or validated from
  // the published capture / processing contract. No caller URL is ever fetched.
  const url = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${publication.commitSha}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/octet-stream" } });
    if (response.status !== 200 || response.headers.has("content-range")) {
      await response.body?.cancel();
      throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "IO_ERROR");
    }
    return await boundedBytes(response.body, maximum, new CallbackError("PUBLICATION_NOT_VERIFIED", 502, failureCode));
  } catch (error) {
    if (error instanceof CallbackError) throw error;
    // Fetch exception text and upstream bodies are deliberately not returned or
    // persisted: only fixed error codes cross the callback boundary.
    throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "IO_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

export const result = httpAction(async (ctx, request) => {
  if (!authorized(request.headers.get("authorization"))) return json(401, { error: "UNAUTHORIZED" });
  let callback: Callback | undefined;
  let inputBound = false;
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new CallbackError("UNSUPPORTED_CONTENT_TYPE", 415);
    const lengthHeader = request.headers.get("content-length");
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > MAX_PROCESSING_MANIFEST_BYTES)) {
      throw new CallbackError("BODY_TOO_LARGE", 413);
    }
    const bytes = await boundedBytes(request.body, MAX_PROCESSING_MANIFEST_BYTES, new CallbackError("BODY_TOO_LARGE", 413));
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new CallbackError("INVALID_BODY", 400); }
    callback = parseCallback(value);
    if (callback.status === "failed") {
      const recorded: FunctionReturnType<typeof internal.processing.recordFailure> = await ctx.runMutation(internal.processing.recordFailure, { captureId: callback.captureId as Id<"captures">, inputSha256: callback.inputSha256, processorRevision: callback.processorRevision, code: callback.code });
      return json(200, recorded);
    }
    const manifest = callback.manifest;
    const input: FunctionReturnType<typeof internal.processing.getCaptureForVerification> = await ctx.runQuery(internal.processing.getCaptureForVerification, { captureId: manifest.captureId as Id<"captures"> });
    if (!input || !input.capture.manifest || !input.capture.publication) throw new CallbackError("CAPTURE_NOT_PUBLISHED", 409);
    if (manifest.input.sha256 !== input.artifact.sha256 || manifest.input.byteLength !== input.artifact.byteLength || manifest.input.artifactPath !== input.artifact.path || manifest.fixture !== input.capture.manifest.fixture) {
      throw new CallbackError("PROCESSING_INPUT_MISMATCH", 409);
    }
    inputBound = true;
    const canonicalCapture = utf8(canonicalCaptureManifestText(input.capture.manifest));
    const inputManifestHash = await sha256(canonicalCapture);
    if (inputManifestHash !== manifest.input.manifestSha256) throw new CallbackError("PROCESSING_INPUT_MISMATCH", 409, "INPUT_HASH_MISMATCH");
    const sourcePublication = { owner: callback.publication.owner, repo: callback.publication.repo, commitSha: manifest.input.commitSha };
    const captureBytes = await corpusFile(sourcePublication, manifestPathForCapture(manifest.captureId), canonicalCapture.byteLength, "INPUT_HASH_MISMATCH");
    if (captureBytes.byteLength !== canonicalCapture.byteLength || await sha256(captureBytes) !== inputManifestHash) throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "INPUT_HASH_MISMATCH");
    const rawBytes = await corpusFile(sourcePublication, input.artifact.path, input.artifact.byteLength, "INPUT_HASH_MISMATCH");
    const inputHash = await sha256(rawBytes);
    if (rawBytes.byteLength !== input.artifact.byteLength || inputHash !== input.artifact.sha256) throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "INPUT_HASH_MISMATCH");
    const expectedReceipt = utf8(processingManifestText(manifest));
    const receiptBytes = await corpusFile(callback.publication, processingManifestPathForCapture(manifest.captureId, manifest.processor.revision), expectedReceipt.byteLength, "IO_ERROR");
    const receiptHash = await sha256(receiptBytes);
    if (receiptBytes.byteLength !== expectedReceipt.byteLength || receiptHash !== await sha256(expectedReceipt)) throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "IO_ERROR");
    const outputBytes = await corpusFile(callback.publication, manifest.output.path, manifest.output.byteLength, "IO_ERROR");
    const outputHash = await sha256(outputBytes);
    if (outputBytes.byteLength !== manifest.output.byteLength || outputHash !== manifest.output.sha256) throw new CallbackError("PUBLICATION_NOT_VERIFIED", 502, "IO_ERROR");
    const recorded: FunctionReturnType<typeof internal.processing.recordSuccess> = await ctx.runMutation(internal.processing.recordSuccess, {
      manifest,
      publication: callback.publication,
      proof: { inputSha256: inputHash, inputByteLength: rawBytes.byteLength, inputManifestSha256: inputManifestHash, outputSha256: outputHash, outputByteLength: outputBytes.byteLength, receiptSha256: receiptHash },
    });
    return json(200, recorded);
  } catch (error) {
    if (error instanceof CallbackError) {
      if (callback?.status === "succeeded" && inputBound && error.failureCode) {
        try {
          await ctx.runMutation(internal.processing.recordFailure, { captureId: callback.manifest.captureId as Id<"captures">, inputSha256: callback.manifest.input.sha256, processorRevision: callback.manifest.processor.revision, code: error.failureCode });
        } catch { /* Preserve the safe original callback response. */ }
      }
      return json(error.status, { error: error.code });
    }
    if (error instanceof ConvexError && typeof error.data === "object" && error.data !== null && "code" in error.data) {
      const code = error.data.code;
      if (code === "PROCESSING_CONFLICT" || code === "CAPTURE_NOT_PUBLISHED" || code === "PROCESSING_INPUT_MISMATCH" || code === "PROCESSING_PROOF_MISMATCH") return json(409, { error: code });
    }
    return json(503, { error: "CALLBACK_FAILED" });
  }
});
