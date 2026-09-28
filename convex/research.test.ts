// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { conservativeUrlKey } from "@bmw-knowledge/collection/policy";
import { MAX_MCP_REQUEST_BYTES, MAX_RESEARCH_MARKDOWN_BYTES, parseResearchToolOutput, RESEARCH_INSTRUCTION_TEXT, RESEARCH_INSTRUCTION_VERSION, RESEARCH_TOOL_ERROR_CODES, RESEARCH_TOOL_ERROR_MESSAGES, RESEARCH_TOOL_NAMES, type ResearchToolName } from "@bmw-knowledge/mcp/contract";
import { canonicalCaptureManifestText, normalizedPathForCapture, processingManifestText, PROCESSOR_NAME, PROCESSOR_VERSION } from "@bmw-knowledge/normalization/contract";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sha256, utf8 } from "./digests";
import schema from "./schema";
import { captureManifestValidator, processingManifestValidator } from "./validators";

const modules = import.meta.glob("./**/*.ts");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const SECRET = "research-fixture-secret-0123456789abcdef";
const APPROVAL = { origin: "https://example.com", pathPrefix: "/approved", approvedBy: "Test maintainer", basis: "Synthetic owned bytes; plumbing fixture only.", approvedAt: "2026-09-28T11:00:00.000Z", fixture: true };
const RUN = { idempotencyKey: "run-one", client: "Convex test fixture", mode: "interactive" as const, objective: "Discover E30 rear-light source references, without extracting automotive facts." };
const DISCOVERY = { url: "https://example.org/reference", title: "Synthetic research reference", relevance: "Useful wiring reference for E30 source discovery.", series: ["E30" as const], topics: ["electrical"], language: "en", bodyStyles: ["sedan"], referrerUrl: "https://example.org/index" };
const REPORT = { idempotencyKey: "report-one", title: "Synthetic cited research report", summary: "Fixture report about research leads, not a verified automotive fact.", markdown: "# Unverified fixture\n\nA synthetic externally authored report.", series: ["E30" as const], topics: ["electrical"], citations: [{ url: "https://example.org/cited-only", title: "Cited-only fixture", note: "This citation is stored without automatic collection." }] };
const FINISH = { outcome: "Recorded useful references.", unresolvedLeads: [{ url: "https://example.org/next", note: "Check this source next." }], nextDirections: ["Find a model-year-specific primary source."] };

function backend() { return convexTest(schema, modules); }
type Backend = ReturnType<typeof backend>;

async function counts(t: Backend) {
  return await t.run(async (ctx) => ({
    sources: (await ctx.db.query("sources").withIndex("by_creation_time").take(100)).length,
    submissions: (await ctx.db.query("submissions").withIndex("by_creation_time").take(100)).length,
    jobs: (await ctx.db.query("jobs").withIndex("by_creation_time").take(100)).length,
    captures: (await ctx.db.query("captures").withIndex("by_creation_time").take(100)).length,
    runs: (await ctx.db.query("researchRuns").withIndex("by_creation_time").take(100)).length,
    batches: (await ctx.db.query("researchBatches").withIndex("by_creation_time").take(100)).length,
    discoveries: (await ctx.db.query("discoveries").withIndex("by_creation_time").take(100)).length,
    reports: (await ctx.db.query("researchReports").withIndex("by_creation_time").take(100)).length,
  }));
}

async function begin(t: Backend, overrides: Partial<typeof RUN> = {}) {
  return await t.mutation(internal.research.beginRun, { ...RUN, ...overrides });
}

async function rpc(t: Backend, method: string, params: Record<string, unknown> = {}, id = 1) {
  const response = await t.fetch("/mcp", { method: "POST", headers: { authorization: "Bearer " + SECRET, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const body: unknown = await response.json();
  expect(body).toBeTypeOf("object");
  return { response, body: body as Record<string, unknown> };
}

async function tool<Name extends ResearchToolName>(t: Backend, name: Name, args: Record<string, unknown>) {
  const { response, body } = await rpc(t, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  const result = body.result as Record<string, unknown>;
  expect(result?.isError).not.toBe(true);
  return parseResearchToolOutput(name, result.structuredContent);
}

function toolErrorCode(body: Record<string, unknown>): unknown {
  const result = body.result as Record<string, unknown> | undefined;
  expect(result?.isError).toBe(true);
  // SDK clients validate structuredContent against the cached success schema,
  // even for isError results. Failures carry only a fixed JSON text envelope.
  expect(result).not.toHaveProperty("structuredContent");
  expect(result?.content).toEqual([{ type: "text", text: expect.any(String) }]);
  const content = result?.content as Array<{ type: "text"; text: string }>;
  const value: unknown = JSON.parse(content[0]?.text ?? "");
  expect(value).toBeTypeOf("object");
  const envelope = value as Record<string, unknown>;
  const error = envelope.error as Record<string, unknown>;
  const code = RESEARCH_TOOL_ERROR_CODES.find((candidate) => candidate === error?.code);
  if (code === undefined) throw new Error("Expected a fixed research error code.");
  expect(envelope).toEqual({ error: { code, message: RESEARCH_TOOL_ERROR_MESSAGES[code] } });
  return code;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
  for (const name of ["COLLECTION_MAX_BYTES", "COLLECTION_TIMEOUT_MS", "RESEARCH_MCP_SECRET", "RESEARCH_SCOPE_JSON", "CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH", "CORPUS_GITHUB_TOKEN", "PROCESSING_CALLBACK_SECRET", "S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) vi.stubEnv(name, undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Research must not fetch source bodies."); }));
});

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("research run and discovery transactions", () => {
  test("read-only brief and configuration expose versioned scope without beginning a run or leaking secrets", async () => {
    const t = backend();
    vi.stubEnv("CORPUS_GITHUB_TOKEN", "private-github-test-marker");
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "private-s3-test-marker");
    const brief = await t.query(internal.research.getBrief, {});
    expect(brief).toMatchObject({ instructionVersion: RESEARCH_INSTRUCTION_VERSION, instruction: RESEARCH_INSTRUCTION_TEXT, scope: { series: ["E30", "E46"], focus: [], bodyStyles: [], operationalLanguage: "en" }, approvals: { count: 1, rules: [{ origin: APPROVAL.origin, fixture: true }], truncated: false }, recentRuns: [], recentReports: [] });
    expect(parseResearchToolOutput("get_research_brief", brief)).toEqual(brief);
    expect(await t.query(internal.research.getConfiguration, {})).toMatchObject({ authentication: { developerBearerConfigured: false, developerBearerEnabled: false, chatGptOAuthConfigured: false } });
    vi.stubEnv("RESEARCH_MCP_SECRET", "");
    expect(await t.query(internal.research.getConfiguration, {})).toMatchObject({ authentication: { developerBearerConfigured: true, developerBearerEnabled: false } });
    vi.stubEnv("RESEARCH_MCP_SECRET", SECRET);
    const configuration = await t.query(internal.research.getConfiguration, {});
    expect(configuration.authentication).toEqual({ developerBearerConfigured: true, developerBearerEnabled: true, chatGptOAuthConfigured: false });
    expect(JSON.stringify({ brief, configuration })).not.toMatch(/private-github-test-marker|private-s3-test-marker|research-fixture-secret/);
    expect((await counts(t)).runs).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("concurrent identical begin calls cache one run and its original brief; changed payload conflicts", async () => {
    const t = backend();
    const [first, second] = await Promise.all([begin(t), begin(t)]);
    expect(second).toEqual(first);
    await t.mutation(internal.research.submitDiscoveries, { runId: first.runId, idempotencyKey: "later-source", discoveries: [DISCOVERY] });
    vi.stubEnv("RESEARCH_SCOPE_JSON", JSON.stringify({ series: ["E30"], focus: ["electrical"], operationalLanguage: "en" }));
    expect(await begin(t)).toEqual(first);
    expect((await t.query(internal.research.getBrief, {})).recentSources).toHaveLength(1);
    await expect(begin(t, { objective: "Different work" })).rejects.toThrow("different arguments");
    // @ts-expect-error Exercise the native validator against an extra untrusted field.
    await expect(t.mutation(internal.research.beginRun, { ...RUN, instructionVersion: "researcher-chosen" })).rejects.toThrow();
    expect((await counts(t)).runs).toBe(1);
  });

  test("concurrent batch replay returns stable provenance IDs; known URLs never schedule another job", async () => {
    const t = backend();
    const { runId } = await begin(t);
    const approved = { ...DISCOVERY, url: "https://example.com/approved/wiring", title: "First title" };
    const input = { runId, idempotencyKey: "batch-one", discoveries: [approved, DISCOVERY] };
    const [first, replay] = await Promise.all([t.mutation(internal.research.submitDiscoveries, input), t.mutation(internal.research.submitDiscoveries, input)]);
    expect(replay).toEqual(first);
    expect(first.results.map((result) => result.status)).toEqual(["accepted", "deferred"]);
    expect(first.results.every((result) => result.discoveryId !== undefined)).toBe(true);
    expect(parseResearchToolOutput("submit_discoveries", first)).toEqual(first);
    const approvedResult = first.results[0];
    if (!approvedResult?.jobId) throw new Error("Expected the approved fixture job.");
    const before = await t.query(internal.collection.getStatus, { jobId: approvedResult.jobId });
    const another = await t.mutation(internal.research.submitDiscoveries, { runId, idempotencyKey: "batch-two", discoveries: [{ ...approved, title: "A later discovery context", relevance: "Different source-context relevance", topics: ["rear-lights"] }] });
    expect(another.results[0]).toMatchObject({ sourceId: approvedResult.sourceId, jobId: approvedResult.jobId, status: "known" });
    expect(another.results[0]?.discoveryId).not.toBe(approvedResult.discoveryId);
    expect((await t.query(internal.collection.getStatus, { jobId: approvedResult.jobId }))?.job.source).toEqual(before?.job.source);
    expect((await counts(t))).toMatchObject({ sources: 2, jobs: 1, captures: 0, batches: 2, discoveries: 3 });
    await expect(t.mutation(internal.research.submitDiscoveries, { ...input, discoveries: [{ ...approved, relevance: "Changed payload" }] })).rejects.toThrow("different arguments");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a late nested collection failure rolls back the full batch, source enrichment and earlier submission", async () => {
    const t = backend();
    const known = await t.mutation(internal.collection.submitSource, { url: DISCOVERY.url, title: DISCOVERY.title, relevance: DISCOVERY.relevance, series: DISCOVERY.series, idempotencyKey: "preexisting-source" });
    const original = await t.run(async (ctx) => await ctx.db.get("sources", known.sourceId));
    const { runId } = await begin(t);
    const before = await counts(t);
    // The first known URL bypasses acquisition policy and writes submission /
    // metadata / provenance. The second new URL then fails inside submitSource.
    vi.stubEnv("COLLECTION_APPROVALS_JSON", "invalid-private-config-marker");
    const input = { runId, idempotencyKey: "atomic-batch", discoveries: [{ ...DISCOVERY, topics: ["must-roll-back"] }, { ...DISCOVERY, url: "https://example.org/new-after-known" }] };
    await expect(t.mutation(internal.research.submitDiscoveries, input)).rejects.toThrow();
    expect(await counts(t)).toEqual(before);
    expect(await t.run(async (ctx) => await ctx.db.get("sources", known.sourceId))).toEqual(original);
    vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
    const retry = await t.mutation(internal.research.submitDiscoveries, input);
    expect(retry.results.map((result) => result.status)).toEqual(["known", "deferred"]);
    expect((await counts(t))).toMatchObject({ batches: 1, discoveries: 2, sources: 2, jobs: 0 });
  });

  test.each(["interactive", "manual_deep_research"] as const)("finishing a %s run closes fresh writes while exact report/batch replays remain stable", async (mode) => {
    const t = backend();
    const { runId } = await t.mutation(internal.research.beginRun, { ...RUN, mode });
    const batchInput = { runId, idempotencyKey: "batch-one", discoveries: [DISCOVERY] };
    const reportInput = { ...REPORT, runId };
    const batch = await t.mutation(internal.research.submitDiscoveries, batchInput);
    const report = await t.mutation(internal.research.saveReport, reportInput);
    const finishInput = { ...FINISH, runId };
    const [finished, replay] = await Promise.all([t.mutation(internal.research.finishRun, finishInput), t.mutation(internal.research.finishRun, finishInput)]);
    expect(replay).toEqual(finished);
    expect(await t.mutation(internal.research.submitDiscoveries, batchInput)).toEqual(batch);
    expect(await t.mutation(internal.research.saveReport, reportInput)).toEqual(report);
    await expect(t.mutation(internal.research.submitDiscoveries, { ...batchInput, idempotencyKey: "new-batch" })).rejects.toThrow("finished research run");
    await expect(t.mutation(internal.research.saveReport, { ...reportInput, idempotencyKey: "new-report" })).rejects.toThrow("finished research run");
    await expect(t.mutation(internal.research.finishRun, { ...finishInput, outcome: "Changed finish" })).rejects.toThrow("different finish result");
    await expect(t.mutation(internal.research.saveReport, { ...reportInput, summary: "Changed report" })).rejects.toThrow("different arguments");
    expect((await counts(t))).toMatchObject({ runs: 1, reports: 1, batches: 1, discoveries: 1 });
    expect((await t.query(internal.research.getBrief, {})).recentRuns[0]).toMatchObject({ status: "finished", unresolvedLeads: [{ url: FINISH.unresolvedLeads[0]?.url, note: FINISH.unresolvedLeads[0]?.note }], nextDirections: [{ direction: FINISH.nextDirections[0] }] });
  });
});

describe("research metadata, reports and actual collection state", () => {
  test("legacy and partially indexed sources remain readable; re-submission fills indexes without reacquisition", async () => {
    const t = backend();
    const legacyId = await t.run(async (ctx) => await ctx.db.insert("sources", { urlKey: DISCOVERY.url, url: DISCOVERY.url, title: "Legacy lamp wiring", relevance: DISCOVERY.relevance, series: DISCOVERY.series, domain: "example.org" }));
    const initial = await t.query(internal.research.searchSources, { url: DISCOVERY.url + "#section" });
    expect(initial).toMatchObject({ sources: [{ sourceId: legacyId, domain: "example.org", topics: [], bodyStyles: [], metadataIndexed: false, acquisitionEligibility: "reference_only" }], legacyMetadataNotIndexed: true });
    // convex-test 0.0.60 cannot search a missing optional string field; it calls
    // split(undefined). Legacy text-index exclusion requires a real dev-runtime
    // check; exact URL/domain compatibility remains covered here.
    expect(await t.query(internal.research.searchSources, { domain: "example.org" })).toMatchObject({ sources: [{ sourceId: legacyId, metadataIndexed: false }], legacyMetadataNotIndexed: true });
    const { runId } = await begin(t);
    const batch = await t.mutation(internal.research.submitDiscoveries, { runId, idempotencyKey: "legacy-enrichment", discoveries: [{ ...DISCOVERY, topics: ["electrics"], bodyStyles: ["coupe"] }] });
    expect(batch.results[0]).toMatchObject({ sourceId: legacyId, status: "known", jobId: null });
    expect(await t.query(internal.research.searchSources, { query: "electrics" })).toMatchObject({ sources: [{ sourceId: legacyId, title: "Legacy lamp wiring", metadataIndexed: true }], legacyMetadataNotIndexed: false });
    expect((await t.query(internal.research.searchSources, { domain: "example.org" })).sources).toHaveLength(1);
    expect((await counts(t))).toMatchObject({ jobs: 0, captures: 0 });
  });

  test("indexed labels are bounded while every discovery retains exact provenance, language and referrer", async () => {
    const t = backend();
    const { runId } = await begin(t);
    let sourceId: Id<"sources"> | undefined;
    for (let batch = 0; batch < 5; batch++) {
      const labels = Array.from({ length: 8 }, (_, index) => "topic" + (batch * 8 + index));
      const result = await t.mutation(internal.research.submitDiscoveries, { runId, idempotencyKey: "labels-" + batch, discoveries: [{ ...DISCOVERY, topics: labels, bodyStyles: labels, language: batch === 0 ? "en" : "ro" }] });
      sourceId = result.results[0]?.sourceId;
    }
    if (!sourceId) throw new Error("Expected the indexed source.");
    const id = sourceId;
    const indexed = await t.query(internal.research.searchSources, { query: "topic31" });
    expect(indexed.sources[0]).toMatchObject({ sourceId, metadataTruncated: true, language: "en" });
    expect(indexed.sources[0]?.topics).toHaveLength(32);
    expect(indexed.sources[0]?.bodyStyles).toHaveLength(32);
    const provenance = await t.run(async (ctx) => await ctx.db.query("discoveries").withIndex("by_sourceId", (q) => q.eq("sourceId", id)).order("desc").take(1));
    expect(provenance[0]).toMatchObject({ referrerUrl: DISCOVERY.referrerUrl, language: "ro", topics: Array.from({ length: 8 }, (_, index) => "topic" + (32 + index)) });
    expect((await counts(t))).toMatchObject({ sources: 1, jobs: 0, discoveries: 5 });
  });

  test("report writes are immutable, cited and unverified; UTF-8 byte limits do not acquire cited URLs", async () => {
    const t = backend();
    const { runId } = await begin(t);
    const markdown = "🚙".repeat(MAX_RESEARCH_MARKDOWN_BYTES / 4);
    const input = { ...REPORT, runId, markdown };
    const [saved, replay] = await Promise.all([t.mutation(internal.research.saveReport, input), t.mutation(internal.research.saveReport, input)]);
    expect(replay).toEqual(saved);
    const result = await t.query(internal.research.getReport, { reportId: saved.reportId });
    expect(result.report).toMatchObject({ title: REPORT.title, summary: REPORT.summary, citations: REPORT.citations, runId, reportId: saved.reportId, markdown, kind: "manual_research_report", verification: "unverified_research" });
    expect(parseResearchToolOutput("get_research_report", result)).toEqual(result);
    await expect(t.mutation(internal.research.saveReport, { ...input, idempotencyKey: "too-large", markdown: markdown + "🚙" })).rejects.toThrow("supported bounds");
    await expect(t.mutation(internal.research.saveReport, { ...input, idempotencyKey: "uncited", citations: [] })).rejects.toThrow("supported bounds");
    // @ts-expect-error Research callers cannot select a trusted fact label.
    await expect(t.mutation(internal.research.saveReport, { ...input, verification: "verified_fact" })).rejects.toThrow();
    expect((await counts(t))).toMatchObject({ reports: 1, sources: 0, submissions: 0, jobs: 0, captures: 0, discoveries: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("scheduled runs cannot save reports; maintainer scope cannot be expanded by discovery inputs", async () => {
    const t = backend();
    const scheduled = await t.mutation(internal.research.beginRun, { ...RUN, mode: "scheduled" });
    await expect(t.mutation(internal.research.saveReport, { ...REPORT, runId: scheduled.runId })).rejects.toThrow("Only interactive or manual");
    vi.stubEnv("RESEARCH_SCOPE_JSON", JSON.stringify({ series: ["E30"], focus: ["electrical"], bodyStyles: ["sedan"], operationalLanguage: "en" }));
    const scoped = await begin(t, { idempotencyKey: "scoped" });
    await expect(t.mutation(internal.research.submitDiscoveries, { runId: scoped.runId, idempotencyKey: "wrong-series", discoveries: [{ ...DISCOVERY, series: ["E46"] }] })).rejects.toThrow("maintainer scope");
    await expect(t.mutation(internal.research.saveReport, { ...REPORT, runId: scoped.runId, series: ["E46"] })).rejects.toThrow("maintainer scope");
    expect((await counts(t))).toMatchObject({ sources: 0, reports: 0, batches: 0 });
  });

  test("brief preserves prior leads with bounded summaries and never splits an emoji or includes Markdown", async () => {
    const t = backend();
    const { runId } = await begin(t);
    const sources = Array.from({ length: 12 }, (_, index) => ({ ...DISCOVERY, url: "https://example.org/source-" + index, relevance: index === 11 ? "r".repeat(499) + "🚙more" : DISCOVERY.relevance }));
    await t.mutation(internal.research.submitDiscoveries, { runId, idempotencyKey: "recent-sources", discoveries: sources });
    for (let index = 0; index < 7; index++) {
      const current = await begin(t, { idempotencyKey: "recent-run-" + index, objective: "o".repeat(599) + "🚙more" });
      await t.mutation(internal.research.saveReport, { ...REPORT, runId: current.runId, idempotencyKey: "recent-report-" + index, summary: "s".repeat(499) + "🚙more", markdown: "PRIVATE_REPORT_MARKDOWN_NOT_IN_BRIEF" });
      await t.mutation(internal.research.finishRun, {
        runId: current.runId, outcome: "x".repeat(599) + "🚙more",
        unresolvedLeads: Array.from({ length: 4 }, (_, lead) => ({ url: "https://example.org/lead-" + lead, note: "n".repeat(299) + "🚙more" })),
        nextDirections: Array.from({ length: 4 }, () => "d".repeat(299) + "🚙more"),
      });
    }
    const result = await t.query(internal.research.getBrief, {});
    expect(result.recentSources).toHaveLength(10);
    expect(result.recentRuns).toHaveLength(5);
    expect(result.recentReports).toHaveLength(5);
    expect(result.recentSources[0]).toMatchObject({ relevance: "r".repeat(499), relevanceTruncated: true });
    expect(result.recentReports[0]).toMatchObject({ summary: "s".repeat(499), summaryTruncated: true });
    expect(result.recentRuns[0]).toMatchObject({ objective: "o".repeat(599), objectiveTruncated: true, outcome: "x".repeat(599), outcomeTruncated: true, unresolvedLeadsTruncated: true, nextDirectionsTruncated: true });
    expect(result.recentRuns[0]?.unresolvedLeads).toHaveLength(3);
    expect(result.recentRuns[0]?.unresolvedLeads[0]).toEqual({ url: "https://example.org/lead-0", note: "n".repeat(299), noteTruncated: true });
    expect(result.recentRuns[0]?.nextDirections[0]).toEqual({ direction: "d".repeat(299), truncated: true });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_REPORT_MARKDOWN_NOT_IN_BRIEF");
    expect(parseResearchToolOutput("get_research_brief", result)).toEqual(result);
  });

  test("status follows the actual latest job, publication and per-capture normalization result", async () => {
    const t = backend();
    const submitted = await t.mutation(internal.collection.submitSource, { url: "https://example.com/approved/status", relevance: DISCOVERY.relevance, series: DISCOVERY.series, idempotencyKey: "status-source" });
    const jobId = submitted.jobId;
    if (!jobId) throw new Error("Expected fixture job.");
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected claim.");
    await t.mutation(internal.collection.recordFailed, { jobId, attempt: claim.attempt, code: "TEST_IO_ERROR", message: "private error must not be exposed" });
    expect((await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] })).sources[0]).toMatchObject({ job: { status: "failed", errorCode: "TEST_IO_ERROR" }, capture: { status: "reserved", publication: null }, processing: [] });
    await t.mutation(internal.collection.retryJob, { jobId });
    const retry = await t.mutation(internal.collection.claimJob, { jobId });
    if (!retry) throw new Error("Expected retry.");
    const bytes = utf8("Synthetic captured text.");
    const hash = await sha256(bytes);
    const manifest: Infer<typeof captureManifestValidator> = { schemaVersion: 1, kind: "http_response_capture", source: retry.request.source, jobId, captureId: retry.request.captureId, requestedUrl: conservativeUrlKey(retry.request.source.url), finalUrl: conservativeUrlKey(retry.request.source.url), retrievedAt: NOW.toISOString(), http: { status: 200, contentType: "text/plain", contentLength: bytes.byteLength, etag: null, lastModified: null }, redirects: [], artifact: { sha256: hash, byteLength: bytes.byteLength, mediaType: "text/plain", path: "raw/sha256/" + hash }, approval: APPROVAL, fixture: true, completeness: "Complete HTTP response body; linked pages and attachments were not acquired." };
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: retry.attempt, manifest });
    expect((await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] })).sources[0]?.capture?.publication).toBeNull();
    const commitSha = "a".repeat(40);
    const artifactPath = manifest.artifact.path;
    const manifestPath = "captures/" + manifest.captureId + ".json";
    const prefix = "https://github.com/alexcatdad/bmw-corpus/blob/" + commitSha + "/";
    await t.mutation(internal.collection.recordPublished, { jobId, attempt: retry.attempt, publication: { owner: "alexcatdad", repo: "bmw-corpus", branch: "main", commitSha, artifactPath, manifestPath, artifactUrl: prefix + artifactPath, manifestUrl: prefix + manifestPath } });
    const captureId = retry.request.captureId as Id<"captures">;
    const revision = "b".repeat(40);
    await t.mutation(internal.processing.recordFailure, { captureId, inputSha256: hash, processorRevision: revision, code: "IO_ERROR" });
    expect((await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] })).sources[0]).toMatchObject({ job: { status: "succeeded" }, capture: { status: "published", publication: { commitSha } }, processing: [{ status: "failed", output: null }] });
    const output = utf8("Synthetic normalized text.\n");
    const outputHash = await sha256(output);
    const manifestHash = await sha256(utf8(canonicalCaptureManifestText(manifest)));
    const processing: Infer<typeof processingManifestValidator> = { schemaVersion: 1, kind: "normalization_result", captureId, input: { artifactPath, sha256: hash, byteLength: bytes.byteLength, manifestSha256: manifestHash, commitSha }, processor: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION, revision }, output: { path: normalizedPathForCapture(captureId, revision, "text/plain"), sha256: outputHash, byteLength: output.byteLength, mediaType: "text/plain" }, fixture: true, warnings: [] };
    await t.mutation(internal.processing.recordSuccess, { manifest: processing, publication: { owner: "alexcatdad", repo: "bmw-corpus", commitSha }, proof: { inputSha256: hash, inputByteLength: bytes.byteLength, inputManifestSha256: manifestHash, outputSha256: outputHash, outputByteLength: output.byteLength, receiptSha256: await sha256(utf8(processingManifestText(processing))) } });
    const success = await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] });
    expect(success.sources[0]?.processing[0]).toMatchObject({ status: "succeeded", output: { commitSha, url: prefix + processing.output.path } });
    expect(parseResearchToolOutput("get_collection_status", success)).toEqual(success);
    vi.stubEnv("COLLECTION_APPROVALS_JSON", undefined);
    expect((await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] })).sources[0]).toMatchObject({ source: { acquisitionEligibility: "reference_only" }, capture: { publication: { commitSha } } });
    vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
    await t.mutation(internal.collection.submitSource, { url: manifest.source.url, relevance: DISCOVERY.relevance, series: DISCOVERY.series, idempotencyKey: "reacquire-status", reacquire: true });
    expect((await t.query(internal.research.getCollectionStatus, { sourceIds: [submitted.sourceId] })).sources[0]).toMatchObject({ job: { status: "queued" }, capture: null, processing: [] });
  });

  test("direct internal inputs are bounded and cannot grant approval or reacquisition", async () => {
    const t = backend();
    const { runId } = await begin(t);
    const input = { runId, idempotencyKey: "bounded", discoveries: [DISCOVERY] };
    await expect(t.mutation(internal.research.submitDiscoveries, { ...input, discoveries: Array.from({ length: 26 }, (_, index) => ({ ...DISCOVERY, url: "https://example.org/" + index })) })).rejects.toThrow("supported bounds");
    await expect(t.mutation(internal.research.submitDiscoveries, { ...input, discoveries: [{ ...DISCOVERY, topics: Array.from({ length: 9 }, () => "topic") }] })).rejects.toThrow("supported bounds");
    // @ts-expect-error Exercise native validation of researcher-supplied rights.
    await expect(t.mutation(internal.research.submitDiscoveries, { ...input, discoveries: [{ ...DISCOVERY, approval: APPROVAL, reacquire: true }] })).rejects.toThrow();
    await expect(t.query(internal.research.searchSources, { url: DISCOVERY.url, domain: "example.org" })).rejects.toThrow("supported bounds");
    await expect(t.query(internal.research.searchSources, { query: "electrical", limit: 21 })).rejects.toThrow("supported bounds");
    await expect(t.mutation(internal.research.finishRun, { ...FINISH, runId, unresolvedLeads: Array.from({ length: 11 }, () => ({ note: "lead" })) })).rejects.toThrow("supported bounds");
    const sourceIds = await t.run(async (ctx) => await Promise.all(Array.from({ length: 21 }, (_, index) => ctx.db.insert("sources", { url: "https://example.org/bound-" + index, urlKey: "https://example.org/bound-" + index, relevance: "Synthetic bound fixture", series: ["E30"] }))));
    await expect(t.query(internal.research.getCollectionStatus, { sourceIds })).rejects.toThrow("supported bounds");
    const one = sourceIds[0];
    if (!one) throw new Error("Expected a source ID.");
    await expect(t.query(internal.research.getCollectionStatus, { sourceIds: [one, one] })).rejects.toThrow("supported bounds");
    expect((await counts(t))).toMatchObject({ jobs: 0, captures: 0, discoveries: 0, batches: 0, reports: 0 });
  });
});

describe("authenticated remote research MCP", () => {
  test("authentication rejects absent, weak and wrong secrets before parsing streamed request bodies", async () => {
    const t = backend();
    const consumed = vi.fn();
    const request = () => ({
      method: "POST",
      headers: { authorization: "Bearer " + SECRET, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: new ReadableStream<Uint8Array>({ pull(controller) { consumed(); controller.enqueue(utf8("not valid JSON")); controller.close(); } }, { highWaterMark: 0 }),
      duplex: "half" as const,
    });
    for (const configured of [undefined, "short", "a".repeat(257), "a".repeat(32) + "+", ""]) {
      vi.stubEnv("RESEARCH_MCP_SECRET", configured);
      expect((await t.fetch("/mcp", request())).status).toBe(401);
    }
    expect(consumed).not.toHaveBeenCalled();
    vi.stubEnv("RESEARCH_MCP_SECRET", SECRET);
    vi.stubEnv("PROCESSING_CALLBACK_SECRET", "different-processing-secret-0123456789");
    for (const supplied of [undefined, SECRET.slice(1), SECRET + "x", "x" + SECRET.slice(1), "different-processing-secret-0123456789"]) {
      const response = await t.fetch("/mcp", { method: "POST", headers: supplied !== undefined ? { authorization: "Bearer " + supplied } : {}, body: "invalid-private-body" });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("invalid-private-body");
    }
    expect((await counts(t)).runs).toBe(0);
  });

  test("GET/DELETE authenticate then return 405; oversized streams and browser origins are rejected", async () => {
    const t = backend();
    vi.stubEnv("RESEARCH_MCP_SECRET", SECRET);
    for (const method of ["GET", "DELETE"]) {
      expect((await t.fetch("/mcp", { method })).status).toBe(401);
      const response = await t.fetch("/mcp", { method, headers: { authorization: "Bearer " + SECRET } });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_MCP_REQUEST_BYTES + 1)); controller.close(); } });
    const streamed: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: "Bearer " + SECRET, "content-type": "application/json" }, body: oversized, duplex: "half" };
    expect((await t.fetch("/mcp", streamed)).status).toBe(413);
    const originResponse = await t.fetch("/mcp", { method: "POST", headers: { authorization: "Bearer " + SECRET, "content-type": "application/json", origin: "https://unapproved-browser.example" }, body: "{}" });
    expect(originResponse.status).toBe(403);
    expect(originResponse.headers.has("access-control-allow-origin")).toBe(false);
  });

  test("real SDK HTTP routing lists only the eight tools and executes the narrow read/write lifecycle", async () => {
    const t = backend();
    vi.stubEnv("RESEARCH_MCP_SECRET", SECRET);
    const initialized = await rpc(t, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Convex fixture", version: "1.0.0" } });
    expect(initialized.response.status).toBe(200);
    expect(initialized.body.result).toMatchObject({ instructions: RESEARCH_INSTRUCTION_TEXT });
    const listed = await rpc(t, "tools/list");
    const listedResult = listed.body.result as { tools: Array<{ name: string }> };
    expect(listedResult.tools.map((entry) => entry.name)).toEqual([...RESEARCH_TOOL_NAMES]);
    const initial = await tool(t, "get_research_brief", {});
    expect(initial.recentRuns).toEqual([]);
    const begun = await tool(t, "begin_research_run", RUN);
    const batch = await tool(t, "submit_discoveries", { runId: begun.runId, idempotencyKey: "mcp-batch", discoveries: [DISCOVERY] });
    const sourceId = batch.results[0]?.sourceId;
    if (!sourceId) throw new Error("Expected a discovery source.");
    expect(batch.results[0]).toMatchObject({ status: "deferred", jobId: null });
    expect((await tool(t, "search_sources", { domain: "example.org" })).sources).toHaveLength(1);
    expect((await tool(t, "get_collection_status", { sourceIds: [sourceId] })).sources[0]).toMatchObject({ exists: true, job: null, capture: null, processing: [] });
    const saved = await tool(t, "save_research_report", { ...REPORT, runId: begun.runId });
    expect((await tool(t, "get_research_report", { reportId: saved.reportId })).report).toMatchObject({ markdown: REPORT.markdown, verification: "unverified_research" });
    await tool(t, "finish_research_run", { ...FINISH, runId: begun.runId });
    expect(await tool(t, "submit_discoveries", { runId: begun.runId, idempotencyKey: "mcp-batch", discoveries: [DISCOVERY] })).toEqual(batch);
    expect(await tool(t, "save_research_report", { ...REPORT, runId: begun.runId })).toEqual(saved);
    const closed = await rpc(t, "tools/call", { name: "save_research_report", arguments: { ...REPORT, runId: begun.runId, idempotencyKey: "fresh-after-finish" } });
    expect(toolErrorCode(closed.body)).toBe("RUN_FINISHED");
    const changed = await rpc(t, "tools/call", { name: "begin_research_run", arguments: { ...RUN, objective: "private-changed-objective-marker" } });
    expect(toolErrorCode(changed.body)).toBe("IDEMPOTENCY_CONFLICT");
    expect(JSON.stringify(changed.body)).not.toContain("private-changed-objective-marker");
    expect((await counts(t))).toMatchObject({ runs: 1, sources: 1, discoveries: 1, reports: 1, jobs: 0, captures: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("MCP arguments cannot access acquisition/admin functions or expose raw configuration errors", async () => {
    const t = backend();
    vi.stubEnv("RESEARCH_MCP_SECRET", SECRET);
    for (const name of ["collection.claimJob", "collection.retryJob", "research.getConfiguration", "run", "execute", "envSet"]) {
      const unknown = await rpc(t, "tools/call", { name, arguments: {} });
      expect(unknown.body.error).toMatchObject({ code: -32601 });
    }
    const begun = await tool(t, "begin_research_run", RUN);
    const injected = await rpc(t, "tools/call", { name: "submit_discoveries", arguments: { runId: begun.runId, idempotencyKey: "injected", discoveries: [{ ...DISCOVERY, approval: APPROVAL, reacquire: true }] } });
    expect(injected.body.error).toMatchObject({ code: -32602 });
    vi.stubEnv("RESEARCH_SCOPE_JSON", JSON.stringify({ unexpected: "private-config-error-marker" }));
    const invalid = await rpc(t, "tools/call", { name: "get_research_brief", arguments: {} });
    expect(toolErrorCode(invalid.body)).toBe("INVALID_CONFIGURATION");
    expect(JSON.stringify(invalid.body)).not.toMatch(/private-config-error-marker|stack|RESEARCH_SCOPE_JSON/);
    expect((await counts(t))).toMatchObject({ sources: 0, jobs: 0, captures: 0, reports: 0 });
  });
});
