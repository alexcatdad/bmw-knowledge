import { approvedRuleForUrl, conservativeUrlKey, isBoundedText, policyFromConfiguration, type CollectionPolicy } from "@bmw-knowledge/collection/policy";
import { parseResearchToolInput, RESEARCH_INSTRUCTION_TEXT, RESEARCH_INSTRUCTION_VERSION, type ResearchToolArguments, type ResearchToolName } from "@bmw-knowledge/mcp/contract";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { sha256, utf8 } from "./digests";
import { strongResearchSecret } from "./researchSecurity";
import {
  discoveryBatchResultValidator,
  discoveryResultValidator,
  discoveryValidator,
  researchBriefValidator,
  researchCitationValidator,
  researchCollectionStatusValidator,
  researchModeValidator,
  researchReportValidator,
  researchScopeValidator,
  researchSourceSummaryValidator,
  unresolvedLeadValidator,
} from "./researchValidators";
import { enrichSourceMetadata, preview, sourceSummary } from "./sourceSearch";
import { seriesValidator, submissionResultValidator } from "./validators";

type ResearchScope = Infer<typeof researchScopeValidator>;
type ResearchBrief = Infer<typeof researchBriefValidator>;
type CollectionStatus = Infer<typeof researchCollectionStatusValidator>;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function parseInput<Name extends ResearchToolName>(name: Name, input: unknown): ResearchToolArguments<Name> {
  try { return parseResearchToolInput(name, input); } catch { return fail("INVALID_INPUT", "The research operation arguments do not meet the supported bounds."); }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const fields = value as Record<string, unknown>;
  return `{${Object.keys(fields).filter((key) => fields[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key])}`).join(",")}}`;
}

async function fingerprint(value: unknown): Promise<string> {
  return await sha256(utf8(canonicalJson(value)));
}

function scope(): ResearchScope {
  const raw = env.RESEARCH_SCOPE_JSON;
  if (raw === undefined || raw === "") return { series: ["E30", "E46"], focus: [], bodyStyles: [], operationalLanguage: "en" };
  try {
    if (utf8(raw).byteLength > 16 * 1024) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["series", "focus", "bodyStyles", "operationalLanguage"].includes(key))) throw new Error();
    const series = value.series ?? ["E30", "E46"];
    if (!Array.isArray(series) || series.length < 1 || series.length > 2 || !series.every((item) => item === "E30" || item === "E46") || new Set(series).size !== series.length) throw new Error();
    const labels = (input: unknown): string[] => {
      if (input === undefined) return [];
      if (!Array.isArray(input) || input.length > 8 || !input.every((item): item is string => typeof item === "string" && isBoundedText(item, 80)) || new Set(input).size !== input.length) throw new Error();
      return input;
    };
    if (value.operationalLanguage !== undefined && value.operationalLanguage !== "en") throw new Error();
    return { series, focus: labels(value.focus), bodyStyles: labels(value.bodyStyles), operationalLanguage: "en" };
  } catch { return fail("INVALID_CONFIGURATION", "The maintainer research scope configuration is invalid."); }
}

function collectionPolicy(): CollectionPolicy {
  try {
    return policyFromConfiguration(env.COLLECTION_APPROVALS_JSON, env.COLLECTION_MAX_BYTES, env.COLLECTION_TIMEOUT_MS);
  } catch { return fail("INVALID_CONFIGURATION", "The maintainer collection approval configuration is invalid."); }
}

function summary(source: Doc<"sources">, policy: CollectionPolicy, maximum = 4000) {
  return { ...sourceSummary(source, maximum), acquisitionEligibility: approvedRuleForUrl(source.url, policy) ? "approved" as const : "reference_only" as const };
}

async function brief(ctx: QueryCtx): Promise<ResearchBrief> {
  const policy = collectionPolicy();
  const [sources, runs, reports] = await Promise.all([
    ctx.db.query("sources").withIndex("by_creation_time").order("desc").take(10),
    ctx.db.query("researchRuns").withIndex("by_creation_time").order("desc").take(5),
    ctx.db.query("researchReports").withIndex("by_creation_time").order("desc").take(5),
  ]);
  return {
    scope: scope(),
    instructionVersion: RESEARCH_INSTRUCTION_VERSION,
    instruction: RESEARCH_INSTRUCTION_TEXT,
    approvals: {
      count: policy.approvals.length,
      rules: policy.approvals.slice(0, 10).map(({ origin, pathPrefix, fixture, approvedAt }) => ({ origin, pathPrefix, fixture, approvedAt })),
      truncated: policy.approvals.length > 10,
    },
    recentSources: sources.map((source) => summary(source, policy, 500)),
    recentRuns: runs.map((run) => ({
      runId: run._id,
      client: run.client,
      mode: run.mode,
      objective: preview(run.objective, 600),
      objectiveTruncated: run.objective.length > 600,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      outcome: run.outcome !== undefined ? preview(run.outcome, 600) : null,
      outcomeTruncated: (run.outcome?.length ?? 0) > 600,
      unresolvedLeads: (run.unresolvedLeads ?? []).slice(0, 3).map((lead) => ({ ...(lead.url !== undefined ? { url: lead.url } : {}), note: preview(lead.note, 300), noteTruncated: lead.note.length > 300 })),
      unresolvedLeadsTruncated: (run.unresolvedLeads?.length ?? 0) > 3,
      nextDirections: (run.nextDirections ?? []).slice(0, 3).map((direction) => ({ direction: preview(direction, 300), truncated: direction.length > 300 })),
      nextDirectionsTruncated: (run.nextDirections?.length ?? 0) > 3,
    })),
    recentReports: reports.map((report) => ({ reportId: report._id, runId: report.runId, kind: report.kind, verification: report.verification, title: report.title, summary: preview(report.summary, 500), summaryTruncated: report.summary.length > 500, series: report.series, topics: report.topics, createdAt: report.createdAt })),
  };
}

function checkSeries(run: Doc<"researchRuns">, series: Array<"E30" | "E46">): void {
  if (series.some((item) => !run.beginBrief.scope.series.includes(item))) fail("INVALID_INPUT", "The record series must remain within this research run's maintainer scope.");
}

async function sourceStatus(ctx: QueryCtx, sourceId: Id<"sources">, policy: CollectionPolicy): Promise<CollectionStatus> {
  const source = await ctx.db.get("sources", sourceId);
  if (!source) return { sourceId, exists: false, source: null, job: null, capture: null, processing: [] };
  const candidateJob = source.latestJobId ? await ctx.db.get("jobs", source.latestJobId) : null;
  const job = candidateJob?.sourceId === sourceId ? candidateJob : null;
  const candidateCapture = job?.captureId ? await ctx.db.get("captures", job.captureId) : null;
  const capture = candidateCapture?.sourceId === sourceId && candidateCapture.jobId === job?._id ? candidateCapture : null;
  const processing = capture ? await ctx.db.query("processingResults").withIndex("by_captureId", (q) => q.eq("captureId", capture._id)).order("desc").take(10) : [];
  return {
    sourceId,
    exists: true,
    source: summary(source, policy),
    job: job ? { jobId: job._id, status: job.status, phase: job.phase, errorCode: job.error && /^[A-Z][A-Z0-9_]{0,79}$/.test(job.error.code) ? job.error.code : null } : null,
    capture: capture ? {
      captureId: capture._id,
      status: capture.status,
      fixture: capture.manifest?.fixture ?? null,
      publication: capture.status === "published" && job?.status === "succeeded" && capture.publication ? { commitSha: capture.publication.commitSha, artifactUrl: capture.publication.artifactUrl, manifestUrl: capture.publication.manifestUrl } : null,
    } : null,
    processing: processing.map((result) => ({
      processorRevision: result.processorRevision,
      status: result.status,
      errorCode: result.error?.code ?? null,
      verifiedAt: result.verifiedAt ?? null,
      output: result.status === "succeeded" && result.manifest && result.publication ? {
        ...result.manifest.output,
        commitSha: result.publication.commitSha,
        url: `https://github.com/${result.publication.owner}/${result.publication.repo}/blob/${result.publication.commitSha}/${result.manifest.output.path}`,
      } : null,
    })),
  };
}

export const getConfiguration = internalQuery({
  args: {},
  returns: v.object({
    scope: researchScopeValidator,
    instructionVersion: v.literal(RESEARCH_INSTRUCTION_VERSION),
    authentication: v.object({ developerBearerConfigured: v.boolean(), developerBearerEnabled: v.boolean(), chatGptOAuthConfigured: v.literal(false) }),
  }),
  handler: async () => ({
    scope: scope(),
    instructionVersion: RESEARCH_INSTRUCTION_VERSION,
    authentication: { developerBearerConfigured: env.RESEARCH_MCP_SECRET !== undefined, developerBearerEnabled: strongResearchSecret(env.RESEARCH_MCP_SECRET), chatGptOAuthConfigured: false as const },
  }),
});

export const getBrief = internalQuery({
  args: {},
  returns: researchBriefValidator,
  handler: async (ctx) => await brief(ctx),
});

export const beginRun = internalMutation({
  args: { idempotencyKey: v.string(), client: v.string(), mode: researchModeValidator, objective: v.string() },
  returns: v.object({ runId: v.id("researchRuns"), brief: researchBriefValidator }),
  handler: async (ctx, args) => {
    const input = parseInput("begin_research_run", args);
    const requestFingerprint = await fingerprint(input);
    const prior = await ctx.db.query("researchRuns").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", input.idempotencyKey)).unique();
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) fail("IDEMPOTENCY_CONFLICT", "This research run key was already used for different arguments.");
      return { runId: prior._id, brief: prior.beginBrief };
    }
    const beginBrief = await brief(ctx);
    const runId = await ctx.db.insert("researchRuns", { ...input, requestFingerprint, instructionVersion: RESEARCH_INSTRUCTION_VERSION, status: "open", startedAt: Date.now(), beginBrief });
    return { runId, brief: beginBrief };
  },
});

export const searchSources = internalQuery({
  args: { url: v.optional(v.string()), domain: v.optional(v.string()), query: v.optional(v.string()), limit: v.optional(v.number()) },
  returns: v.object({ sources: v.array(researchSourceSummaryValidator), legacyMetadataNotIndexed: v.boolean() }),
  handler: async (ctx, args) => {
    const input = parseInput("search_sources", args);
    let sources: Doc<"sources">[];
    if (input.url !== undefined) {
      const urlKey = conservativeUrlKey(input.url);
      const source = await ctx.db.query("sources").withIndex("by_urlKey", (q) => q.eq("urlKey", urlKey)).unique();
      sources = source ? [source] : [];
    } else if (input.domain !== undefined) {
      sources = await ctx.db.query("sources").withIndex("by_domain", (q) => q.eq("domain", input.domain)).order("desc").take(input.limit);
    } else {
      const query = input.query;
      if (query === undefined) fail("INVALID_INPUT", "Exactly one source lookup criterion is required.");
      sources = await ctx.db.query("sources").withSearchIndex("search_searchText", (q) => q.search("searchText", query)).take(input.limit);
    }
    // Missing optional metadata is indexed as undefined. One indexed read can
    // disclose legacy coverage without scanning the corpus or pretending those
    // documents participated in domain/full-text search.
    const legacy = await ctx.db.query("sources").withIndex("by_searchMetadataVersion", (q) => q.eq("searchMetadataVersion", undefined)).take(1);
    const policy = collectionPolicy();
    return { sources: sources.map((source) => summary(source, policy)), legacyMetadataNotIndexed: legacy.length > 0 };
  },
});

export const submitDiscoveries = internalMutation({
  args: { runId: v.id("researchRuns"), idempotencyKey: v.string(), discoveries: v.array(discoveryValidator) },
  returns: discoveryBatchResultValidator,
  handler: async (ctx, args) => {
    const input = parseInput("submit_discoveries", args);
    const requestFingerprint = await fingerprint(input);
    const prior = await ctx.db.query("researchBatches").withIndex("by_runId_and_idempotencyKey", (q) => q.eq("runId", args.runId).eq("idempotencyKey", input.idempotencyKey)).unique();
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) fail("IDEMPOTENCY_CONFLICT", "This discovery batch key was already used for different arguments.");
      return { batchId: prior._id, results: prior.results };
    }
    const run = await ctx.db.get("researchRuns", args.runId);
    if (!run) fail("RUN_NOT_FOUND", "The research run does not exist.");
    if (run.status !== "open") fail("RUN_FINISHED", "New discovery batches cannot be added to a finished research run.");
    for (const discovery of input.discoveries) checkSeries(run, discovery.series);
    const batchId = await ctx.db.insert("researchBatches", { runId: run._id, idempotencyKey: input.idempotencyKey, requestFingerprint, results: [], recordedAt: Date.now() });
    const results: Infer<typeof discoveryResultValidator>[] = [];
    for (let index = 0; index < input.discoveries.length; index++) {
      const discovery = input.discoveries[index];
      if (!discovery) fail("INVALID_INPUT", "The discovery batch is incomplete.");
      // The researcher never supplies a collection key or acquisition rights.
      // A nested mutation participates in this enclosing atomic transaction;
      // an error is deliberately allowed to roll back every discovery/job.
      const result: Infer<typeof submissionResultValidator> = await ctx.runMutation(internal.collection.submitSource, {
        url: discovery.url,
        ...(discovery.title !== undefined ? { title: discovery.title } : {}),
        relevance: discovery.relevance,
        series: discovery.series,
        idempotencyKey: `research:${await fingerprint({ batchId, index })}`,
      });
      const source = await ctx.db.get("sources", result.sourceId);
      if (!source) fail("TOOL_FAILED", "The discovery source could not be recorded.");
      await ctx.db.patch("sources", source._id, enrichSourceMetadata(source, {
        ...(discovery.topics !== undefined ? { topics: discovery.topics } : {}),
        ...(discovery.bodyStyles !== undefined ? { bodyStyles: discovery.bodyStyles } : {}),
        ...(discovery.language !== undefined ? { language: discovery.language } : {}),
      }));
      const discoveryId = await ctx.db.insert("discoveries", {
        runId: run._id,
        batchId,
        sourceId: result.sourceId,
        jobId: result.jobId,
        status: result.status,
        url: discovery.url,
        ...(discovery.title !== undefined ? { title: discovery.title } : {}),
        relevance: discovery.relevance,
        series: discovery.series,
        topics: discovery.topics ?? [],
        bodyStyles: discovery.bodyStyles ?? [],
        ...(discovery.language !== undefined ? { language: discovery.language } : {}),
        ...(discovery.referrerUrl !== undefined ? { referrerUrl: discovery.referrerUrl } : {}),
        submittedAt: Date.now(),
      });
      results.push({ ...result, discoveryId });
    }
    await ctx.db.patch("researchBatches", batchId, { results });
    return { batchId, results };
  },
});

export const getCollectionStatus = internalQuery({
  args: { sourceIds: v.array(v.id("sources")) },
  returns: v.object({ sources: v.array(researchCollectionStatusValidator) }),
  handler: async (ctx, args) => {
    parseInput("get_collection_status", args);
    const policy = collectionPolicy();
    return { sources: await Promise.all(args.sourceIds.map((sourceId) => sourceStatus(ctx, sourceId, policy))) };
  },
});

export const finishRun = internalMutation({
  args: { runId: v.id("researchRuns"), outcome: v.string(), unresolvedLeads: v.array(unresolvedLeadValidator), nextDirections: v.array(v.string()) },
  returns: v.object({ runId: v.id("researchRuns"), status: v.literal("finished") }),
  handler: async (ctx, args) => {
    const input = parseInput("finish_research_run", args);
    const run = await ctx.db.get("researchRuns", args.runId);
    if (!run) fail("RUN_NOT_FOUND", "The research run does not exist.");
    const finishFingerprint = await fingerprint(input);
    if (run.status === "finished") {
      if (run.finishFingerprint !== finishFingerprint) fail("IDEMPOTENCY_CONFLICT", "This research run already has a different finish result.");
      return { runId: run._id, status: "finished" as const };
    }
    await ctx.db.patch("researchRuns", run._id, {
      status: "finished", finishedAt: Date.now(), finishFingerprint, outcome: input.outcome,
      unresolvedLeads: input.unresolvedLeads.map((lead) => ({ note: lead.note, ...(lead.url !== undefined ? { url: lead.url } : {}) })),
      nextDirections: input.nextDirections,
    });
    return { runId: run._id, status: "finished" as const };
  },
});

export const saveReport = internalMutation({
  args: { runId: v.id("researchRuns"), idempotencyKey: v.string(), title: v.string(), summary: v.string(), markdown: v.string(), series: v.array(seriesValidator), topics: v.array(v.string()), citations: v.array(researchCitationValidator) },
  returns: v.object({ reportId: v.id("researchReports"), kind: v.literal("manual_research_report"), verification: v.literal("unverified_research") }),
  handler: async (ctx, args) => {
    const input = parseInput("save_research_report", args);
    const requestFingerprint = await fingerprint(input);
    const prior = await ctx.db.query("researchReports").withIndex("by_runId_and_idempotencyKey", (q) => q.eq("runId", args.runId).eq("idempotencyKey", input.idempotencyKey)).unique();
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) fail("IDEMPOTENCY_CONFLICT", "This research report key was already used for different arguments.");
      return { reportId: prior._id, kind: prior.kind, verification: prior.verification };
    }
    const run = await ctx.db.get("researchRuns", args.runId);
    if (!run) fail("RUN_NOT_FOUND", "The research run does not exist.");
    if (run.mode === "scheduled") fail("REPORT_MODE_NOT_ALLOWED", "Only interactive or manual Deep Research runs can save cited research reports.");
    if (run.status !== "open") fail("RUN_FINISHED", "New reports cannot be added to a finished research run.");
    checkSeries(run, input.series);
    const reportId = await ctx.db.insert("researchReports", {
      ...input, runId: run._id, requestFingerprint, kind: "manual_research_report", verification: "unverified_research", createdAt: Date.now(),
      citations: input.citations.map((citation) => ({ url: citation.url, ...(citation.title !== undefined ? { title: citation.title } : {}), ...(citation.note !== undefined ? { note: citation.note } : {}) })),
    });
    return { reportId, kind: "manual_research_report" as const, verification: "unverified_research" as const };
  },
});

export const getReport = internalQuery({
  args: { reportId: v.id("researchReports") },
  returns: v.object({ report: v.union(researchReportValidator, v.null()) }),
  handler: async (ctx, args) => {
    parseInput("get_research_report", args);
    const report = await ctx.db.get("researchReports", args.reportId);
    if (!report) return { report: null };
    return { report: { reportId: report._id, runId: report.runId, kind: report.kind, verification: report.verification, title: report.title, summary: report.summary, markdown: report.markdown, series: report.series, topics: report.topics, citations: report.citations, createdAt: report.createdAt } };
  },
});
