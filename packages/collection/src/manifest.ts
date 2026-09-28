import { createHash } from "node:crypto";
import { z } from "zod";
import { CollectionError } from "./errors.js";
import { artifactPathForHash, RECORD_ID_PATTERN, SHA256_PATTERN } from "./paths.js";
import { approvedRuleForUrl, conservativeUrlKey, FULL_CAPTURE_HTTP_STATUS, isBoundedText, isUtcTimestamp, MAX_CAPTURE_BYTES, MAX_COMPLETENESS_LENGTH, MAX_HTTP_CONTENT_TYPE_LENGTH, MAX_HTTP_ETAG_LENGTH, MAX_HTTP_LAST_MODIFIED_LENGTH, MAX_REDIRECTS, MAX_SOURCE_RELEVANCE_LENGTH, MAX_SOURCE_SERIES, MAX_SOURCE_TITLE_LENGTH, MAX_SOURCE_URL_LENGTH, MIN_SOURCE_SERIES, policyFromConfiguration, SUPPORTED_MEDIA_TYPES, validateSourceMetadata } from "./policy.js";
import type { CaptureManifest, StoredCapture } from "./types.js";

export { validateSourceMetadata } from "./policy.js";

const sourceUrl = z.string().max(MAX_SOURCE_URL_LENGTH).refine((value) => {
  try {
    conservativeUrlKey(value);
    return true;
  } catch {
    return false;
  }
}, "Source URL must meet the acquisition URL policy");

const sourceMetadataSchema = z.object({
  id: z.string().regex(RECORD_ID_PATTERN),
  url: sourceUrl,
  title: z.string().min(1).max(MAX_SOURCE_TITLE_LENGTH).optional(),
  relevance: z.string().min(1).max(MAX_SOURCE_RELEVANCE_LENGTH),
  series: z.array(z.enum(["E30", "E46"])).min(MIN_SOURCE_SERIES).max(MAX_SOURCE_SERIES).refine((series) => new Set(series).size === series.length),
}).strict().refine((source) => {
  try { validateSourceMetadata(source); return true; } catch { return false; }
}).transform((source) => ({
  id: source.id,
  url: source.url,
  ...(source.title === undefined ? {} : { title: source.title }),
  relevance: source.relevance,
  series: source.series,
}));

const approvalSchema = z.object({
  origin: z.string().max(MAX_SOURCE_URL_LENGTH),
  pathPrefix: z.string().max(MAX_SOURCE_URL_LENGTH),
  approvedBy: z.string().min(1).max(200),
  basis: z.string().min(1).max(2000),
  approvedAt: z.string().refine(isUtcTimestamp),
  fixture: z.boolean(),
}).strict().refine((approval) => {
  try {
    policyFromConfiguration(JSON.stringify([approval]));
    return true;
  } catch {
    return false;
  }
}, "Approval must be explicit maintainer configuration");

export const captureManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("http_response_capture"),
  source: sourceMetadataSchema,
  jobId: z.string().regex(RECORD_ID_PATTERN),
  captureId: z.string().regex(RECORD_ID_PATTERN),
  requestedUrl: sourceUrl,
  finalUrl: sourceUrl,
  retrievedAt: z.string().refine(isUtcTimestamp),
  http: z.object({
    status: z.literal(FULL_CAPTURE_HTTP_STATUS),
    contentType: z.string().refine((value) => isBoundedText(value, MAX_HTTP_CONTENT_TYPE_LENGTH)),
    contentLength: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES).nullable(),
    etag: z.string().refine((value) => isBoundedText(value, MAX_HTTP_ETAG_LENGTH, true)).nullable(),
    lastModified: z.string().refine((value) => isBoundedText(value, MAX_HTTP_LAST_MODIFIED_LENGTH, true)).nullable(),
  }).strict(),
  redirects: z.array(sourceUrl).max(MAX_REDIRECTS),
  artifact: z.object({
    sha256: z.string().regex(SHA256_PATTERN),
    byteLength: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES),
    mediaType: z.enum(SUPPORTED_MEDIA_TYPES),
    path: z.string().regex(/^raw\/sha256\/[a-f0-9]{64}$/),
  }).strict(),
  approval: approvalSchema,
  fixture: z.boolean(),
  completeness: z.string().refine((value) => isBoundedText(value, MAX_COMPLETENESS_LENGTH)),
}).strict().superRefine((manifest, context) => {
  const issue = (message: string): void => context.addIssue({ code: "custom", message });
  try {
  if (manifest.artifact.path !== artifactPathForHash(manifest.artifact.sha256)) issue("Artifact path does not match its hash");
  if (manifest.requestedUrl !== conservativeUrlKey(manifest.source.url)) issue("Requested URL does not match the source URL");
  if (manifest.finalUrl !== conservativeUrlKey(manifest.finalUrl)) issue("Final URL is not canonical");
  if (manifest.fixture !== manifest.approval.fixture) issue("Fixture provenance is inconsistent");
  if (manifest.http.contentLength !== null && manifest.http.contentLength !== manifest.artifact.byteLength) issue("Declared length does not match the complete captured body");
  if (manifest.http.contentType.split(";", 1)[0]?.trim().toLowerCase() !== manifest.artifact.mediaType) issue("Content type does not match the artifact media type");
  if (
    (manifest.redirects.length === 0 && manifest.finalUrl !== manifest.requestedUrl) ||
    (manifest.redirects.length !== 0 && manifest.redirects.at(-1) !== manifest.finalUrl)
  ) issue("Redirect provenance does not match the final URL");
  const policy = { approvals: [manifest.approval], maxBytes: MAX_CAPTURE_BYTES, timeoutMs: 15_000, maxRedirects: MAX_REDIRECTS };
  if (approvedRuleForUrl(manifest.requestedUrl, policy) === null) issue("Capture source is outside its recorded approval");
  if (approvedRuleForUrl(manifest.finalUrl, policy) === null || manifest.redirects.some((destination) => approvedRuleForUrl(destination, policy) === null)) issue("Capture redirect left its recorded source approval");
  } catch {
    issue("Capture provenance does not meet its source URL and path contract");
  }
});

export function validateCaptureManifest(value: unknown): CaptureManifest {
  const result = captureManifestSchema.safeParse(value);
  if (!result.success) {
    throw new CollectionError("INVALID_CAPTURE_MANIFEST", "Capture manifest does not match its versioned contract.");
  }
  return result.data;
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateStoredCapture(capture: StoredCapture): StoredCapture {
  const manifest = validateCaptureManifest(capture.manifest);
  if (capture.bytes.byteLength !== manifest.artifact.byteLength || sha256Bytes(capture.bytes) !== manifest.artifact.sha256) {
    throw new CollectionError("CAPTURE_INTEGRITY_FAILED", "Captured bytes do not match the recorded hash and length.");
  }
  return { manifest, bytes: capture.bytes };
}

export function manifestBytes(manifest: CaptureManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(validateCaptureManifest(manifest), null, 2)}\n`);
}
