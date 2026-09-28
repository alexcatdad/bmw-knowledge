import { sha256Bytes } from "@bmw-knowledge/collection";
import type { CaptureManifest } from "@bmw-knowledge/collection";
import type { NormalizeCaptureInput } from "../src/index.js";

export const PROCESSOR_REVISION = "a".repeat(40);
export const INPUT_COMMIT = "b".repeat(40);

export function fixtureInput(body: string | Uint8Array = "<h1>BMW fixture</h1><p>Original text.</p>", mediaType = "text/html"): NormalizeCaptureInput {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const hash = sha256Bytes(bytes);
  const manifest: CaptureManifest = {
    schemaVersion: 1,
    kind: "http_response_capture",
    source: { id: "source-1", url: "https://example.com/start", title: "BMW fixture", relevance: "Project-owned normalization test.", series: ["E30"] },
    jobId: "job-1",
    captureId: "capture-1",
    requestedUrl: "https://example.com/start",
    finalUrl: "https://example.com/start",
    retrievedAt: "2026-09-28T09:01:00.000Z",
    http: { status: 200, contentType: `${mediaType}; charset=utf-8`, contentLength: bytes.byteLength, etag: null, lastModified: null },
    redirects: [],
    artifact: { sha256: hash, byteLength: bytes.byteLength, mediaType, path: `raw/sha256/${hash}` },
    approval: { origin: "https://example.com", pathPrefix: "/", approvedBy: "Alex", basis: "Project-owned fixture approved for public redistribution.", approvedAt: "2026-09-28T09:00:00.000Z", fixture: true },
    fixture: true,
    completeness: "Complete HTTP response body; linked pages and attachments were not acquired.",
  };
  return { manifest, bytes, processorRevision: PROCESSOR_REVISION, inputCommitSha: INPUT_COMMIT };
}

export function reversedObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reversedObjectKeys) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedObjectKeys(item)])) as T;
}
