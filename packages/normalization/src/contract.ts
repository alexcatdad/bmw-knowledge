import { z } from "zod";
import type { CaptureManifest } from "@bmw-knowledge/collection";
import { artifactPathForHash, manifestPathForCapture, MAX_CAPTURE_BYTES } from "@bmw-knowledge/collection/policy";

export const PROCESSOR_NAME = "html-text" as const;
export const PROCESSOR_VERSION = "0.1.0" as const;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const MAX_PROCESSING_MANIFEST_BYTES = 64 * 1024;
export const PROCESSING_FAILURE_CODES = [
  "INVALID_CAPTURE", "INPUT_HASH_MISMATCH", "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_ENCODING", "OUTPUT_LIMIT", "IO_ERROR",
] as const;
export type ProcessingFailureCode = typeof PROCESSING_FAILURE_CODES[number];

export const NORMALIZATION_WARNING_CODES = [
  "layout-not-preserved", "images-not-preserved", "tables-flattened", "linked-resources-not-acquired",
  "active-content-removed", "unsafe-urls-removed", "invalid-base-ignored", "base-url-applied",
  "literal-html-escaped", "utf8-bom-removed", "markdown-treated-as-text",
] as const;
export type NormalizationWarningCode = typeof NORMALIZATION_WARNING_CODES[number];
export type ProcessingOutputMediaType = "text/markdown" | "text/plain";

export class ProcessingError extends Error {
  readonly code: ProcessingFailureCode;

  constructor(code: ProcessingFailureCode, message: string) {
    super(message);
    this.name = "ProcessingError";
    this.code = code;
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

export function isProcessingFailureCode(value: unknown): value is ProcessingFailureCode {
  return typeof value === "string" && (PROCESSING_FAILURE_CODES as readonly string[]).includes(value);
}

function validateRevision(revision: string): void {
  if (!COMMIT_SHA.test(revision)) throw new ProcessingError("INVALID_CAPTURE", "Processing requires an immutable lowercase Git commit identifier.");
}

export function normalizedPathForCapture(captureId: string, revision: string, mediaType: ProcessingOutputMediaType): string {
  try { manifestPathForCapture(captureId); } catch { throw new ProcessingError("INVALID_CAPTURE", "Processing requires a safe capture identifier."); }
  validateRevision(revision);
  if (mediaType !== "text/markdown" && mediaType !== "text/plain") throw new ProcessingError("UNSUPPORTED_MEDIA_TYPE", "Normalized output requires a supported text media type.");
  return `normalized/${captureId}/${revision}/document.${mediaType === "text/markdown" ? "md" : "txt"}`;
}

export function processingManifestPathForCapture(captureId: string, revision: string): string {
  try { manifestPathForCapture(captureId); } catch { throw new ProcessingError("INVALID_CAPTURE", "Processing requires a safe capture identifier."); }
  validateRevision(revision);
  return `processing/${captureId}/${revision}.json`;
}

export const processingManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("normalization_result"),
  captureId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  input: z.object({
    artifactPath: z.string().regex(/^raw\/sha256\/[a-f0-9]{64}$/),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES),
    manifestSha256: z.string().regex(SHA256),
    commitSha: z.string().regex(COMMIT_SHA),
  }).strict(),
  processor: z.object({
    name: z.literal(PROCESSOR_NAME),
    version: z.literal(PROCESSOR_VERSION),
    revision: z.string().regex(COMMIT_SHA),
  }).strict(),
  output: z.object({
    path: z.string().max(256),
    sha256: z.string().regex(SHA256),
    byteLength: z.number().int().nonnegative().max(MAX_OUTPUT_BYTES),
    mediaType: z.enum(["text/markdown", "text/plain"]),
  }).strict(),
  fixture: z.boolean(),
  warnings: z.array(z.enum(NORMALIZATION_WARNING_CODES)).max(NORMALIZATION_WARNING_CODES.length).refine((warnings) => new Set(warnings).size === warnings.length),
}).strict().superRefine((manifest, context) => {
  try {
    if (manifest.input.artifactPath !== artifactPathForHash(manifest.input.sha256)) context.addIssue({ code: "custom", message: "Input path does not match its content hash" });
    if (manifest.output.path !== normalizedPathForCapture(manifest.captureId, manifest.processor.revision, manifest.output.mediaType)) context.addIssue({ code: "custom", message: "Output path does not match its capture, revision and media type" });
  } catch {
    context.addIssue({ code: "custom", message: "Processing paths require valid capture and immutable revision identifiers" });
  }
});

export type ProcessingManifest = z.infer<typeof processingManifestSchema>;

export function validateProcessingManifest(value: unknown): ProcessingManifest {
  const parsed = processingManifestSchema.safeParse(value);
  if (!parsed.success) throw new ProcessingError("INVALID_CAPTURE", "Processing manifest does not match its versioned contract.");
  return parsed.data;
}

export function processingManifestText(value: ProcessingManifest): string {
  const manifest = validateProcessingManifest(value);
  return `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    captureId: manifest.captureId,
    input: { artifactPath: manifest.input.artifactPath, sha256: manifest.input.sha256, byteLength: manifest.input.byteLength, manifestSha256: manifest.input.manifestSha256, commitSha: manifest.input.commitSha },
    processor: { name: manifest.processor.name, version: manifest.processor.version, revision: manifest.processor.revision },
    output: { path: manifest.output.path, sha256: manifest.output.sha256, byteLength: manifest.output.byteLength, mediaType: manifest.output.mediaType },
    fixture: manifest.fixture,
    warnings: manifest.warnings,
  }, null, 2)}\n`;
}

export function processingManifestBytes(value: ProcessingManifest): Uint8Array {
  const bytes = new TextEncoder().encode(processingManifestText(value));
  if (bytes.byteLength > MAX_PROCESSING_MANIFEST_BYTES) throw new ProcessingError("OUTPUT_LIMIT", "Processing receipt exceeds its supported byte limit.");
  return bytes;
}

/** V1 capture serialization matches collection manifestBytes without importing Node code. */
export function canonicalCaptureManifestText(manifest: CaptureManifest): string {
  return `${JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    source: { id: manifest.source.id, url: manifest.source.url, ...(manifest.source.title === undefined ? {} : { title: manifest.source.title }), relevance: manifest.source.relevance, series: manifest.source.series },
    jobId: manifest.jobId,
    captureId: manifest.captureId,
    requestedUrl: manifest.requestedUrl,
    finalUrl: manifest.finalUrl,
    retrievedAt: manifest.retrievedAt,
    http: { status: manifest.http.status, contentType: manifest.http.contentType, contentLength: manifest.http.contentLength, etag: manifest.http.etag, lastModified: manifest.http.lastModified },
    redirects: manifest.redirects,
    artifact: { sha256: manifest.artifact.sha256, byteLength: manifest.artifact.byteLength, mediaType: manifest.artifact.mediaType, path: manifest.artifact.path },
    approval: { origin: manifest.approval.origin, pathPrefix: manifest.approval.pathPrefix, approvedBy: manifest.approval.approvedBy, basis: manifest.approval.basis, approvedAt: manifest.approval.approvedAt, fixture: manifest.approval.fixture },
    fixture: manifest.fixture,
    completeness: manifest.completeness,
  }, null, 2)}\n`;
}
