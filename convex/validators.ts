import { v } from "convex/values";
import { NORMALIZATION_WARNING_CODES, PROCESSING_FAILURE_CODES, PROCESSOR_NAME, PROCESSOR_VERSION } from "@bmw-knowledge/normalization/contract";

export const seriesValidator = v.union(v.literal("E30"), v.literal("E46"));

export const sourceApprovalValidator = v.object({
  origin: v.string(),
  pathPrefix: v.string(),
  approvedBy: v.string(),
  basis: v.string(),
  approvedAt: v.string(),
  fixture: v.boolean(),
});

export const collectionPolicyValidator = v.object({
  approvals: v.array(sourceApprovalValidator),
  maxBytes: v.number(),
  timeoutMs: v.number(),
  maxRedirects: v.number(),
});

export const sourceMetadataValidator = v.object({
  id: v.string(),
  url: v.string(),
  title: v.optional(v.string()),
  relevance: v.string(),
  series: v.array(seriesValidator),
});

export const captureManifestValidator = v.object({
  schemaVersion: v.literal(1),
  kind: v.literal("http_response_capture"),
  source: sourceMetadataValidator,
  jobId: v.string(),
  captureId: v.string(),
  requestedUrl: v.string(),
  finalUrl: v.string(),
  retrievedAt: v.string(),
  http: v.object({
    status: v.number(),
    contentType: v.string(),
    contentLength: v.union(v.number(), v.null()),
    etag: v.union(v.string(), v.null()),
    lastModified: v.union(v.string(), v.null()),
  }),
  redirects: v.array(v.string()),
  artifact: v.object({
    sha256: v.string(),
    byteLength: v.number(),
    mediaType: v.string(),
    path: v.string(),
  }),
  approval: sourceApprovalValidator,
  fixture: v.boolean(),
  completeness: v.string(),
});

export const publicationValidator = v.object({
  owner: v.string(),
  repo: v.string(),
  branch: v.string(),
  commitSha: v.string(),
  artifactPath: v.string(),
  manifestPath: v.string(),
  artifactUrl: v.string(),
  manifestUrl: v.string(),
});

export const jobStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("skipped"),
);

export const jobPhaseValidator = v.union(
  v.literal("queued"),
  v.literal("acquiring"),
  v.literal("staged"),
  v.literal("published"),
);

export const submissionResultValidator = v.object({
  sourceId: v.id("sources"),
  jobId: v.union(v.id("jobs"), v.null()),
  status: v.union(
    v.literal("accepted"),
    v.literal("known"),
    v.literal("deferred"),
  ),
  reason: v.union(v.string(), v.null()),
});

export const jobErrorValidator = v.object({
  code: v.string(),
  message: v.string(),
  at: v.number(),
});

export const processingFailureCodeValidator = v.union(...PROCESSING_FAILURE_CODES.map((code) => v.literal(code)));

export const processingManifestValidator = v.object({
  schemaVersion: v.literal(1),
  kind: v.literal("normalization_result"),
  captureId: v.string(),
  input: v.object({
    artifactPath: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
    manifestSha256: v.string(),
    commitSha: v.string(),
  }),
  processor: v.object({
    name: v.literal(PROCESSOR_NAME),
    version: v.literal(PROCESSOR_VERSION),
    revision: v.string(),
  }),
  output: v.object({
    path: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
    mediaType: v.union(v.literal("text/markdown"), v.literal("text/plain")),
  }),
  fixture: v.boolean(),
  warnings: v.array(v.union(...NORMALIZATION_WARNING_CODES.map((code) => v.literal(code)))),
});

export const processingPublicationValidator = v.object({
  owner: v.string(),
  repo: v.string(),
  commitSha: v.string(),
});

export const processingProofValidator = v.object({
  inputSha256: v.string(),
  inputByteLength: v.number(),
  inputManifestSha256: v.string(),
  outputSha256: v.string(),
  outputByteLength: v.number(),
  receiptSha256: v.string(),
});
