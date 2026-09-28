import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  captureManifestValidator,
  jobErrorValidator,
  jobPhaseValidator,
  jobStatusValidator,
  publicationValidator,
  seriesValidator,
  sourceApprovalValidator,
  sourceMetadataValidator,
  submissionResultValidator,
} from "./validators";

export default defineSchema({
  sources: defineTable({
    urlKey: v.string(),
    url: v.string(),
    title: v.optional(v.string()),
    relevance: v.string(),
    series: v.array(seriesValidator),
    latestJobId: v.optional(v.id("jobs")),
  }).index("by_urlKey", ["urlKey"]),

  submissions: defineTable({
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    result: submissionResultValidator,
  }).index("by_idempotencyKey", ["idempotencyKey"]),

  jobs: defineTable({
    sourceId: v.id("sources"),
    source: sourceMetadataValidator,
    status: jobStatusValidator,
    phase: jobPhaseValidator,
    attempt: v.number(),
    queuedAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    captureId: v.optional(v.id("captures")),
    approval: v.optional(sourceApprovalValidator),
    error: v.optional(jobErrorValidator),
  })
    .index("by_sourceId", ["sourceId"])
    .index("by_status", ["status"]),

  captures: defineTable({
    jobId: v.id("jobs"),
    sourceId: v.id("sources"),
    status: v.union(
      v.literal("reserved"),
      v.literal("staged"),
      v.literal("published"),
    ),
    manifest: v.optional(captureManifestValidator),
    artifactId: v.optional(v.id("artifacts")),
    publication: v.optional(publicationValidator),
    stagingRetention: v.literal("retain"),
  })
    .index("by_jobId", ["jobId"])
    .index("by_sourceId", ["sourceId"]),

  artifacts: defineTable({
    sha256: v.string(),
    byteLength: v.number(),
    path: v.string(),
    processingStatus: v.literal("pending"),
  }).index("by_sha256", ["sha256"]),
});
