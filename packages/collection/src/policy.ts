import { CollectionError } from "./errors.js";
import { RECORD_ID_PATTERN } from "./paths.js";
import type { SourceMetadata } from "./types.js";

export { CollectionError } from "./errors.js";
export { artifactPathForHash, manifestPathForCapture } from "./paths.js";

export interface SourceApproval {
  origin: string;
  pathPrefix: string;
  approvedBy: string;
  basis: string;
  approvedAt: string;
  fixture: boolean;
}

export interface CollectionPolicy {
  approvals: SourceApproval[];
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

export const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_SOURCE_URL_LENGTH = 2048;
export const MAX_SOURCE_TITLE_LENGTH = 500;
export const MAX_SOURCE_RELEVANCE_LENGTH = 4000;
export const MIN_SOURCE_SERIES = 1;
export const MAX_SOURCE_SERIES = 2;
export const MAX_HTTP_CONTENT_TYPE_LENGTH = 256;
export const MAX_HTTP_ETAG_LENGTH = 1024;
export const MAX_HTTP_LAST_MODIFIED_LENGTH = 256;
export const FULL_CAPTURE_HTTP_STATUS = 200;
export const MAX_COMPLETENESS_LENGTH = 2048;
export const MAX_REDIRECTS = 3;
export const SUPPORTED_MEDIA_TYPES = ["text/html", "text/plain", "text/markdown", "application/xhtml+xml"] as const;
export const CAPTURE_MEDIA_TYPES = SUPPORTED_MEDIA_TYPES;
const UNSAFE_PATH_ENCODING = /%(?:2e|2f|5c|25)/i;
const UNSAFE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".test", ".invalid", ".onion", ".home.arpa"];

/** Convex and corpus strings must be well-formed Unicode; preserve original language. */
export function isBoundedText(value: string, maximum: number, allowEmpty = false): boolean {
  if ((!allowEmpty && value.trim().length === 0) || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function isUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

export function sameApproval(left: SourceApproval, right: SourceApproval): boolean {
  return left.origin === right.origin && left.pathPrefix === right.pathPrefix && left.approvedBy === right.approvedBy &&
    left.basis === right.basis && left.approvedAt === right.approvedAt && left.fixture === right.fixture;
}

export function validateSourceMetadata(value: unknown): SourceMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollectionError("INVALID_SOURCE_METADATA", "Source metadata does not match the collection contract.");
  }
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).some((key) => !["id", "url", "title", "relevance", "series"].includes(key)) ||
    typeof source.id !== "string" || !RECORD_ID_PATTERN.test(source.id) ||
    typeof source.url !== "string" || !isBoundedText(source.url, MAX_SOURCE_URL_LENGTH) ||
    typeof source.relevance !== "string" || !isBoundedText(source.relevance, MAX_SOURCE_RELEVANCE_LENGTH) ||
    (source.title !== undefined && (typeof source.title !== "string" || !isBoundedText(source.title, MAX_SOURCE_TITLE_LENGTH))) ||
    !Array.isArray(source.series) || source.series.length < MIN_SOURCE_SERIES || source.series.length > MAX_SOURCE_SERIES ||
    !source.series.every((series) => series === "E30" || series === "E46") || new Set(source.series).size !== source.series.length
  ) {
    throw new CollectionError("INVALID_SOURCE_METADATA", "Source metadata does not match the collection contract.");
  }
  conservativeUrlKey(source.url);
  return { id: source.id, url: source.url, ...(source.title === undefined ? {} : { title: source.title as string }), relevance: source.relevance, series: source.series as Array<"E30" | "E46"> };
}

function rejectUnsafeRawPath(input: string): void {
  // Check before URL parsing: URL removes dot segments, including encoded ones.
  const beforeQuery = input.split(/[?#]/, 1)[0] ?? "";
  if (input.includes("\\") || /[\u0000-\u0020\u007f]/.test(input) || UNSAFE_PATH_ENCODING.test(beforeQuery)) {
    throw new CollectionError("UNSAFE_SOURCE_URL", "Source URLs cannot contain ambiguous path encodings or control characters.");
  }
  const authorityEnd = beforeQuery.indexOf("/", beforeQuery.indexOf("://") + 3);
  const rawPath = authorityEnd === -1 ? "/" : beforeQuery.slice(authorityEnd);
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new CollectionError("UNSAFE_SOURCE_URL", "Source URLs cannot contain path traversal segments.");
  }
}

/** Conservative identity: normalize the HTTPS origin, preserve path/query case and order. */
export function conservativeUrlKey(input: string): string {
  if (input.length > MAX_SOURCE_URL_LENGTH || !isBoundedText(input, MAX_SOURCE_URL_LENGTH)) {
    throw new CollectionError("INVALID_SOURCE_URL", "Source URL exceeds the supported URL bounds.");
  }
  rejectUnsafeRawPath(input);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CollectionError("INVALID_SOURCE_URL", "Source URL must be an absolute HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    throw new CollectionError("UNSAFE_SOURCE_URL", "Sources require HTTPS without credentials or a nonstandard port.");
  }
  const hostname = url.hostname;
  const labels = hostname.split(".");
  if (
    hostname.length > 253 || labels.length < 2 || hostname.endsWith(".") ||
    /^[\d.]+$/.test(hostname) || hostname.includes(":") ||
    UNSAFE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new CollectionError("UNSAFE_SOURCE_URL", "Sources require a public DNS hostname; local hosts and IP literals are excluded.");
  }
  url.hash = "";
  if (url.href.length > MAX_SOURCE_URL_LENGTH) {
    throw new CollectionError("INVALID_SOURCE_URL", "Canonical source URL exceeds the supported URL bounds.");
  }
  return url.href;
}

function validApproval(value: unknown): SourceApproval {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Each approval must be an object.");
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== 6 ||
    typeof object.origin !== "string" || typeof object.pathPrefix !== "string" ||
    typeof object.approvedBy !== "string" || typeof object.basis !== "string" ||
    typeof object.approvedAt !== "string" || typeof object.fixture !== "boolean"
  ) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Approval configuration requires origin, pathPrefix, approvedBy, basis, approvedAt and fixture.");
  }
  const originUrl = new URL(conservativeUrlKey(object.origin));
  if (object.origin.length > MAX_SOURCE_URL_LENGTH || object.pathPrefix.length > MAX_SOURCE_URL_LENGTH || object.origin !== originUrl.origin || !object.pathPrefix.startsWith("/") || /[?#]/.test(object.pathPrefix)) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Approval origins and path prefixes must be explicit and unambiguous.");
  }
  const checkedPath = new URL(conservativeUrlKey(`${object.origin}${object.pathPrefix}`)).pathname;
  if (checkedPath !== object.pathPrefix) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Approval path prefixes cannot change during URL parsing.");
  }
  if (
    !isBoundedText(object.approvedBy, 200) || !isBoundedText(object.basis, 2000) || !isUtcTimestamp(object.approvedAt)
  ) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Each approval needs a maintainer, redistribution basis and UTC approval time.");
  }
  return {
    origin: object.origin,
    pathPrefix: object.pathPrefix,
    approvedBy: object.approvedBy,
    basis: object.basis,
    approvedAt: object.approvedAt,
    fixture: object.fixture,
  };
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CollectionError("INVALID_COLLECTION_LIMIT", "Collection limits must be positive integer strings.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new CollectionError("INVALID_COLLECTION_LIMIT", "Collection limits exceed the supported acquisition bounds.");
  }
  return number;
}

export function policyFromConfiguration(approvalJson?: string, maxBytes?: string, timeoutMs?: string): CollectionPolicy {
  let approvals: unknown = [];
  if (approvalJson !== undefined) {
    try {
      approvals = JSON.parse(approvalJson);
    } catch {
      throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Approval configuration must be a JSON array.");
    }
  }
  if (!Array.isArray(approvals) || approvals.length > 50) {
    throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Approval configuration must be a bounded JSON array.");
  }
  const validatedApprovals = approvals.map(validApproval);
  for (let index = 0; index < validatedApprovals.length; index++) {
    const left = validatedApprovals[index]!;
    for (const right of validatedApprovals.slice(index + 1)) {
      const contains = (prefix: string, path: string): boolean => prefix === "/" || prefix === path || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
      if (left.origin === right.origin && (contains(left.pathPrefix, right.pathPrefix) || contains(right.pathPrefix, left.pathPrefix)) && !sameApproval(left, right)) {
        throw new CollectionError("INVALID_APPROVAL_CONFIGURATION", "Overlapping source approvals must not grant conflicting provenance.");
      }
    }
  }
  return {
    approvals: validatedApprovals,
    maxBytes: boundedInteger(maxBytes, 512 * 1024, MAX_CAPTURE_BYTES),
    timeoutMs: boundedInteger(timeoutMs, 15_000, MAX_TIMEOUT_MS),
    maxRedirects: MAX_REDIRECTS,
  };
}

/** Exact origin plus segment-boundary prefix; never grant approval from source metadata. */
export function approvedRuleForUrl(input: string, policy: CollectionPolicy): SourceApproval | null {
  const url = new URL(conservativeUrlKey(input));
  return policy.approvals.find((approval) => {
    const prefix = approval.pathPrefix;
    return approval.origin === url.origin && (
      prefix === "/" || url.pathname === prefix ||
      url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    );
  }) ?? null;
}
