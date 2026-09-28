import { v } from "convex/values";
import { RESEARCH_INSTRUCTION_TEXT, RESEARCH_INSTRUCTION_VERSION } from "@bmw-knowledge/mcp/contract";
import { jobPhaseValidator, jobStatusValidator, processingFailureCodeValidator, seriesValidator, submissionResultValidator } from "./validators";

export const researchModeValidator = v.union(v.literal("interactive"), v.literal("manual_deep_research"), v.literal("scheduled"));
export const researchRunStatusValidator = v.union(v.literal("open"), v.literal("finished"));
export const researchScopeValidator = v.object({
  series: v.array(seriesValidator),
  focus: v.array(v.string()),
  bodyStyles: v.array(v.string()),
  operationalLanguage: v.literal("en"),
});

export const discoveryValidator = v.object({
  url: v.string(),
  title: v.optional(v.string()),
  relevance: v.string(),
  series: v.array(seriesValidator),
  topics: v.optional(v.array(v.string())),
  language: v.optional(v.string()),
  bodyStyles: v.optional(v.array(v.string())),
  referrerUrl: v.optional(v.string()),
});

export const researchCitationValidator = v.object({ url: v.string(), title: v.optional(v.string()), note: v.optional(v.string()) });
export const unresolvedLeadValidator = v.object({ url: v.optional(v.string()), note: v.string() });

export const researchSourceSummaryValidator = v.object({
  sourceId: v.id("sources"),
  url: v.string(),
  title: v.optional(v.string()),
  relevance: v.string(),
  relevanceTruncated: v.boolean(),
  series: v.array(seriesValidator),
  domain: v.string(),
  topics: v.array(v.string()),
  bodyStyles: v.array(v.string()),
  language: v.optional(v.string()),
  metadataIndexed: v.boolean(),
  metadataTruncated: v.boolean(),
  latestJobId: v.union(v.id("jobs"), v.null()),
  acquisitionEligibility: v.union(v.literal("approved"), v.literal("reference_only")),
});

export const researchRunSummaryValidator = v.object({
  runId: v.id("researchRuns"),
  client: v.string(),
  mode: researchModeValidator,
  objective: v.string(),
  objectiveTruncated: v.boolean(),
  status: researchRunStatusValidator,
  startedAt: v.number(),
  finishedAt: v.union(v.number(), v.null()),
  outcome: v.union(v.string(), v.null()),
  outcomeTruncated: v.boolean(),
  unresolvedLeads: v.array(v.object({ url: v.optional(v.string()), note: v.string(), noteTruncated: v.boolean() })),
  unresolvedLeadsTruncated: v.boolean(),
  nextDirections: v.array(v.object({ direction: v.string(), truncated: v.boolean() })),
  nextDirectionsTruncated: v.boolean(),
});

export const researchReportSummaryValidator = v.object({
  reportId: v.id("researchReports"),
  runId: v.id("researchRuns"),
  kind: v.literal("manual_research_report"),
  verification: v.literal("unverified_research"),
  title: v.string(),
  summary: v.string(),
  summaryTruncated: v.boolean(),
  series: v.array(seriesValidator),
  topics: v.array(v.string()),
  createdAt: v.number(),
});

export const researchBriefValidator = v.object({
  scope: researchScopeValidator,
  instructionVersion: v.literal(RESEARCH_INSTRUCTION_VERSION),
  instruction: v.literal(RESEARCH_INSTRUCTION_TEXT),
  approvals: v.object({
    count: v.number(),
    rules: v.array(v.object({ origin: v.string(), pathPrefix: v.string(), fixture: v.boolean(), approvedAt: v.string() })),
    truncated: v.boolean(),
  }),
  recentSources: v.array(researchSourceSummaryValidator),
  recentRuns: v.array(researchRunSummaryValidator),
  recentReports: v.array(researchReportSummaryValidator),
});

export const discoveryResultValidator = submissionResultValidator.extend({ discoveryId: v.id("discoveries") });
export const discoveryBatchResultValidator = v.object({ batchId: v.id("researchBatches"), results: v.array(discoveryResultValidator) });

export const researchReportValidator = v.object({
  reportId: v.id("researchReports"),
  runId: v.id("researchRuns"),
  kind: v.literal("manual_research_report"),
  verification: v.literal("unverified_research"),
  title: v.string(),
  summary: v.string(),
  markdown: v.string(),
  series: v.array(seriesValidator),
  topics: v.array(v.string()),
  citations: v.array(researchCitationValidator),
  createdAt: v.number(),
});

export const researchCollectionStatusValidator = v.object({
  sourceId: v.id("sources"),
  exists: v.boolean(),
  source: v.union(researchSourceSummaryValidator, v.null()),
  job: v.union(v.object({ jobId: v.id("jobs"), status: jobStatusValidator, phase: jobPhaseValidator, errorCode: v.union(v.string(), v.null()) }), v.null()),
  capture: v.union(v.object({
    captureId: v.id("captures"),
    status: v.union(v.literal("reserved"), v.literal("staged"), v.literal("published")),
    fixture: v.union(v.boolean(), v.null()),
    publication: v.union(v.object({ commitSha: v.string(), artifactUrl: v.string(), manifestUrl: v.string() }), v.null()),
  }), v.null()),
  processing: v.array(v.object({
    processorRevision: v.string(),
    status: v.union(v.literal("failed"), v.literal("succeeded")),
    errorCode: v.union(processingFailureCodeValidator, v.null()),
    verifiedAt: v.union(v.number(), v.null()),
    output: v.union(v.object({ path: v.string(), sha256: v.string(), byteLength: v.number(), mediaType: v.union(v.literal("text/markdown"), v.literal("text/plain")), commitSha: v.string(), url: v.string() }), v.null()),
  })),
});
