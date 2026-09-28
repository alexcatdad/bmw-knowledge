import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  captureManifestValidator,
  jobErrorValidator,
  jobPhaseValidator,
  jobStatusValidator,
  publicationValidator,
  processingFailureCodeValidator,
  processingManifestValidator,
  processingPublicationValidator,
  seriesValidator,
  sourceApprovalValidator,
  sourceMetadataValidator,
  submissionResultValidator,
} from "./validators";
import { discoveryResultValidator, researchBriefValidator, researchCitationValidator, researchModeValidator, researchRunStatusValidator, unresolvedLeadValidator } from "./researchValidators";
import { collectionStagingBackendValidator } from "./collectionExecution";

export default defineSchema({
  sources: defineTable({
    urlKey: v.string(),
    url: v.string(),
    title: v.optional(v.string()),
    relevance: v.string(),
    series: v.array(seriesValidator),
    latestJobId: v.optional(v.id("jobs")),
    domain: v.optional(v.string()),
    searchText: v.optional(v.string()),
    searchMetadataVersion: v.optional(v.literal(1)),
    topics: v.optional(v.array(v.string())),
    language: v.optional(v.string()),
    bodyStyles: v.optional(v.array(v.string())),
    metadataTruncated: v.optional(v.boolean()),
  })
    .index("by_urlKey", ["urlKey"])
    .index("by_domain", ["domain"])
    .index("by_searchMetadataVersion", ["searchMetadataVersion"])
    .searchIndex("search_searchText", { searchField: "searchText" }),

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
    stagingBackend: v.optional(collectionStagingBackendValidator),
    storageId: v.optional(v.id("_storage")),
  })
    .index("by_jobId", ["jobId"])
    .index("by_sourceId", ["sourceId"]),

  artifacts: defineTable({
    sha256: v.string(),
    byteLength: v.number(),
    path: v.string(),
    storageId: v.optional(v.id("_storage")),
  }).index("by_sha256", ["sha256"]),

  processingResults: defineTable({
    captureId: v.id("captures"),
    processorRevision: v.string(),
    inputSha256: v.string(),
    status: v.union(v.literal("failed"), v.literal("succeeded")),
    manifest: v.optional(processingManifestValidator),
    publication: v.optional(processingPublicationValidator),
    verifiedAt: v.optional(v.number()),
    error: v.optional(v.object({ code: processingFailureCodeValidator, message: v.string() })),
    updatedAt: v.number(),
  })
    .index("by_captureId_and_processorRevision", ["captureId", "processorRevision"])
    .index("by_captureId", ["captureId"]),

  processingEvents: defineTable({
    resultId: v.id("processingResults"),
    eventKey: v.string(),
    status: v.union(v.literal("failed"), v.literal("succeeded")),
    code: v.optional(processingFailureCodeValidator),
    publication: v.optional(processingPublicationValidator),
    ignored: v.optional(v.boolean()),
  })
    .index("by_resultId_and_eventKey", ["resultId", "eventKey"])
    .index("by_resultId", ["resultId"]),

  researchRuns: defineTable({
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    client: v.string(),
    mode: researchModeValidator,
    objective: v.string(),
    instructionVersion: v.string(),
    status: researchRunStatusValidator,
    startedAt: v.number(),
    beginBrief: researchBriefValidator,
    finishedAt: v.optional(v.number()),
    finishFingerprint: v.optional(v.string()),
    outcome: v.optional(v.string()),
    unresolvedLeads: v.optional(v.array(unresolvedLeadValidator)),
    nextDirections: v.optional(v.array(v.string())),
  }).index("by_idempotencyKey", ["idempotencyKey"]),

  researchBatches: defineTable({
    runId: v.id("researchRuns"),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    results: v.array(discoveryResultValidator),
    recordedAt: v.number(),
  }).index("by_runId_and_idempotencyKey", ["runId", "idempotencyKey"]),

  discoveries: defineTable({
    runId: v.id("researchRuns"),
    batchId: v.id("researchBatches"),
    sourceId: v.id("sources"),
    jobId: v.union(v.id("jobs"), v.null()),
    status: v.union(v.literal("accepted"), v.literal("known"), v.literal("deferred")),
    url: v.string(),
    title: v.optional(v.string()),
    relevance: v.string(),
    series: v.array(seriesValidator),
    topics: v.array(v.string()),
    language: v.optional(v.string()),
    bodyStyles: v.array(v.string()),
    referrerUrl: v.optional(v.string()),
    submittedAt: v.number(),
  })
    .index("by_runId", ["runId"])
    .index("by_sourceId", ["sourceId"])
    .index("by_batchId", ["batchId"]),

  researchReports: defineTable({
    runId: v.id("researchRuns"),
    idempotencyKey: v.string(),
    requestFingerprint: v.string(),
    kind: v.literal("manual_research_report"),
    verification: v.literal("unverified_research"),
    title: v.string(),
    summary: v.string(),
    markdown: v.string(),
    series: v.array(seriesValidator),
    topics: v.array(v.string()),
    citations: v.array(researchCitationValidator),
    createdAt: v.number(),
  })
    .index("by_runId_and_idempotencyKey", ["runId", "idempotencyKey"])
    .index("by_runId", ["runId"]),
});
