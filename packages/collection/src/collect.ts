import { CollectionError } from "./errors.js";
import { manifestBytes, sha256Bytes, validateCaptureManifest, validateSourceMetadata, validateStoredCapture } from "./manifest.js";
import { artifactPathForHash, assertRecordId } from "./paths.js";
import { approvedRuleForUrl, conservativeUrlKey, FULL_CAPTURE_HTTP_STATUS, MAX_CAPTURE_BYTES, MAX_REDIRECTS, MAX_TIMEOUT_MS, sameApproval, SUPPORTED_MEDIA_TYPES } from "./policy.js";
import type { CollectionPolicy, SourceApproval } from "./policy.js";
import { readResponseBytes, withAbort } from "./stream.js";
import type { CaptureManifest, CollectionDependencies, CollectRequest, GitHubPublication, StoredCapture } from "./types.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_TYPES = new Set<string>(SUPPORTED_MEDIA_TYPES);

function requireApproval(url: string, policy: CollectionPolicy): SourceApproval {
  const approval = approvedRuleForUrl(url, policy);
  if (approval === null) {
    throw new CollectionError("SOURCE_NOT_APPROVED", "The URL has no current maintainer acquisition and redistribution approval.");
  }
  return approval;
}

function requireSameApproval(url: string, policy: CollectionPolicy, requestedApproval: SourceApproval): void {
  if (!sameApproval(requireApproval(url, policy), requestedApproval)) {
    throw new CollectionError("REDIRECT_APPROVAL_CHANGED", "Source redirects must stay within the original complete maintainer approval.");
  }
}

function validatePolicyBounds(policy: CollectionPolicy): void {
  if (
    !Number.isInteger(policy.maxBytes) || policy.maxBytes < 1 || policy.maxBytes > MAX_CAPTURE_BYTES ||
    !Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1 || policy.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(policy.maxRedirects) || policy.maxRedirects < 0 || policy.maxRedirects > MAX_REDIRECTS
  ) {
    throw new CollectionError("INVALID_COLLECTION_LIMIT", "Collection policy exceeds the supported acquisition bounds.");
  }
}

async function fetchCapture(request: CollectRequest, dependencies: CollectionDependencies): Promise<StoredCapture> {
  const { policy } = dependencies;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const requestedUrl = conservativeUrlKey(request.source.url);
  const approval = requireApproval(requestedUrl, policy);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  const redirects: string[] = [];
  let finalUrl = requestedUrl;
  try {
    let response: Response;
    while (true) {
      requireSameApproval(finalUrl, policy, approval);
      response = await withAbort(fetcher(finalUrl, {
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain, text/markdown, application/xhtml+xml",
          "Accept-Encoding": "identity",
          "User-Agent": "bmw-knowledge/0.1 collection",
        },
      }), controller.signal, "FETCH_TIMEOUT", "Source acquisition exceeded its deadline.");
      if (response.redirected || (response.url !== "" && conservativeUrlKey(response.url) !== finalUrl)) {
        throw new CollectionError("UNEXPECTED_REDIRECT", "The HTTP transport followed an unchecked redirect.");
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      void response.body?.cancel().catch(() => undefined);
      if (redirects.length >= policy.maxRedirects) {
        throw new CollectionError("TOO_MANY_REDIRECTS", "Source acquisition exceeded its redirect limit.");
      }
      const location = response.headers.get("location");
      if (location === null) throw new CollectionError("INVALID_REDIRECT", "Redirect response has no destination.");
      // Inspect the raw redirect before URL resolution removes dot segments.
      if (/\\|%(?:2e|2f|5c|25)/i.test(location.split(/[?#]/, 1)[0] ?? "")) {
        throw new CollectionError("UNSAFE_SOURCE_URL", "The redirect destination contains an ambiguous path.");
      }
      finalUrl = conservativeUrlKey(new URL(location, finalUrl).href);
      requireSameApproval(finalUrl, policy, approval);
      redirects.push(finalUrl);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new CollectionError("HTTP_STATUS_FAILED", `Source acquisition returned HTTP ${response.status}.`);
    }
    if (response.status !== FULL_CAPTURE_HTTP_STATUS) {
      void response.body?.cancel().catch(() => undefined);
      throw new CollectionError("UNSUPPORTED_HTTP_STATUS", "Complete-document acquisition supports HTTP 200 responses only.");
    }
    if (response.headers.has("content-range")) {
      void response.body?.cancel().catch(() => undefined);
      throw new CollectionError("UNSUPPORTED_CONTENT_RANGE", "Complete-document acquisition cannot capture a ranged response.");
    }
    const contentType = response.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!SUPPORTED_TYPES.has(mediaType)) {
      throw new CollectionError("UNSUPPORTED_MEDIA_TYPE", "Source response is not a supported HTML or text document.");
    }
    const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
      throw new CollectionError("UNSUPPORTED_CONTENT_ENCODING", "Source ignored the identity encoding request; byte-faithful capture is unavailable.");
    }
    const declaredLength = response.headers.get("content-length");
    let contentLength: number | null = null;
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
        throw new CollectionError("INVALID_HTTP_METADATA", "Source returned an invalid content length.");
      }
      contentLength = Number(declaredLength);
      if (contentLength > policy.maxBytes) throw new CollectionError("RESPONSE_TOO_LARGE", "Source response exceeds the configured byte limit.");
    }
    const bytes = await readResponseBytes(response, policy.maxBytes, controller.signal, "FETCH_TIMEOUT");
    if (contentLength !== null && bytes.byteLength !== contentLength) {
      throw new CollectionError("INCOMPLETE_CAPTURE", "Source response did not match its declared complete body length.");
    }
    const sha256 = sha256Bytes(bytes);
    const manifest = validateCaptureManifest({
      schemaVersion: 1,
      kind: "http_response_capture",
      source: request.source,
      jobId: request.jobId,
      captureId: request.captureId,
      requestedUrl,
      finalUrl,
      retrievedAt: new Date().toISOString(),
      http: {
        status: response.status,
        contentType,
        contentLength,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      },
      redirects,
      artifact: { sha256, byteLength: bytes.byteLength, mediaType, path: artifactPathForHash(sha256) },
      approval,
      fixture: approval.fixture,
      completeness: "Complete HTTP response body; linked pages and attachments were not acquired.",
    });
    return { manifest, bytes };
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    if (controller.signal.aborted) throw new CollectionError("FETCH_TIMEOUT", "Source acquisition exceeded its deadline.");
    throw new CollectionError("FETCH_FAILED", "Source acquisition did not complete.");
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}

function verifyResumedCapture(capture: StoredCapture, request: CollectRequest, policy: CollectionPolicy): StoredCapture {
  const validated = validateStoredCapture(capture);
  const { manifest } = validated;
  if (
    manifest.captureId !== request.captureId || manifest.jobId !== request.jobId ||
    JSON.stringify(manifest.source) !== JSON.stringify(request.source) || manifest.requestedUrl !== conservativeUrlKey(request.source.url)
  ) {
    throw new CollectionError("STAGED_CAPTURE_MISMATCH", "Staged capture does not belong to this acquisition request.");
  }
  const approval = requireApproval(manifest.requestedUrl, policy);
  if (!sameApproval(approval, manifest.approval)) {
    throw new CollectionError("APPROVAL_CHANGED", "The staged capture's maintainer approval changed before publication.");
  }
  requireSameApproval(manifest.finalUrl, policy, approval);
  for (const destination of manifest.redirects) requireSameApproval(destination, policy, approval);
  if (manifest.artifact.byteLength > policy.maxBytes || manifest.redirects.length > policy.maxRedirects) {
    throw new CollectionError("STAGED_CAPTURE_OUTSIDE_POLICY", "Staged capture exceeds the current collection limits.");
  }
  return validated;
}

export async function collectApprovedSource(request: CollectRequest, dependencies: CollectionDependencies): Promise<{ manifest: CaptureManifest; publication: GitHubPublication }> {
  validatePolicyBounds(dependencies.policy);
  assertRecordId(request.jobId);
  assertRecordId(request.captureId);
  const validatedRequest = { ...request, source: validateSourceMetadata(request.source) };
  requireApproval(validatedRequest.source.url, dependencies.policy);
  let capture = await dependencies.staging.load(request.captureId);
  if (capture === null) {
    if (dependencies.expectedManifest !== undefined) {
      throw new CollectionError("STAGING_CHECKPOINT_MISSING", "The saved capture checkpoint has no staging envelope; restore its original evidence before retrying.");
    }
    capture = await fetchCapture(validatedRequest, dependencies);
    await dependencies.staging.save(capture);
  }
  capture = verifyResumedCapture(capture, validatedRequest, dependencies.policy);
  if (dependencies.expectedManifest !== undefined) {
    const expected = manifestBytes(dependencies.expectedManifest);
    const staged = manifestBytes(capture.manifest);
    if (expected.byteLength !== staged.byteLength || !expected.every((byte, index) => byte === staged[index])) {
      throw new CollectionError("STAGING_CHECKPOINT_MISMATCH", "The staged capture differs from its saved immutable provenance checkpoint.");
    }
  }
  await dependencies.onStaged(capture.manifest);
  const publication = await dependencies.publisher.publish(capture);
  return { manifest: capture.manifest, publication };
}
