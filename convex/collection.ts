import {
  approvedRuleForUrl,
  artifactPathForHash,
  CAPTURE_MEDIA_TYPES,
  conservativeUrlKey,
  FULL_CAPTURE_HTTP_STATUS,
  isBoundedText,
  isUtcTimestamp,
  manifestPathForCapture,
  MAX_CAPTURE_BYTES,
  MAX_COMPLETENESS_LENGTH,
  MAX_HTTP_CONTENT_TYPE_LENGTH,
  MAX_HTTP_ETAG_LENGTH,
  MAX_HTTP_LAST_MODIFIED_LENGTH,
  MAX_SOURCE_RELEVANCE_LENGTH,
  MAX_SOURCE_SERIES,
  MAX_SOURCE_TITLE_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  MIN_SOURCE_SERIES,
  policyFromConfiguration,
  sameApproval,
} from "@bmw-knowledge/collection/policy";
import { ConvexError, v, type Infer } from "convex/values";
import { env, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { corpusTarget } from "./corpus";
import {
  captureManifestValidator,
  collectionPolicyValidator,
  publicationValidator,
  seriesValidator,
  sourceMetadataValidator,
  submissionResultValidator,
} from "./validators";

type CaptureManifest = Infer<typeof captureManifestValidator>;
type Publication = Infer<typeof publicationValidator>;

const RECOVERY_AFTER_MS = 15 * 60 * 1000;
const CONFIGURATION_NAMES = [
  "COLLECTION_APPROVALS_JSON", "COLLECTION_MAX_BYTES", "COLLECTION_TIMEOUT_MS",
  "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE",
  "CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH", "CORPUS_GITHUB_TOKEN", "PROCESSING_CALLBACK_SECRET",
] as const;

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function boundedString(value: string, name: string, maximum: number, allowEmpty = false): void {
  if (!isBoundedText(value, maximum, allowEmpty)) {
    fail("INVALID_INPUT", `${name} must be a nonempty bounded string.`);
  }
}

function integer(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("INVALID_INPUT", `${name} must be an integer within the supported bounds.`);
  }
}

function policy() {
  return policyFromConfiguration(env.COLLECTION_APPROVALS_JSON, env.COLLECTION_MAX_BYTES, env.COLLECTION_TIMEOUT_MS);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

async function runningJob(ctx: MutationCtx, jobId: Id<"jobs">, attempt: number): Promise<Doc<"jobs">> {
  integer(attempt, "attempt", 1, Number.MAX_SAFE_INTEGER);
  const job = await ctx.db.get("jobs", jobId);
  if (!job) fail("JOB_NOT_FOUND", "The collection job does not exist.");
  if (job.status !== "running" || job.attempt !== attempt) {
    fail("STALE_WORKER_ATTEMPT", "Only the current running attempt may update this job.");
  }
  return job;
}

async function reservedCapture(ctx: MutationCtx, job: Doc<"jobs">): Promise<Doc<"captures">> {
  if (!job.captureId) fail("CAPTURE_NOT_RESERVED", "Claim the job before recording its capture.");
  const capture = await ctx.db.get("captures", job.captureId);
  if (!capture || capture.jobId !== job._id || capture.sourceId !== job.sourceId) {
    fail("CAPTURE_NOT_RESERVED", "The reserved capture does not match this job.");
  }
  return capture;
}

function validateManifest(job: Doc<"jobs">, capture: Doc<"captures">, manifest: CaptureManifest): void {
  const configuredPolicy = policy();
  if (manifest.jobId !== job._id || manifest.captureId !== capture._id || canonicalJson(manifest.source) !== canonicalJson(job.source)) {
    fail("CAPTURE_IDENTITY_MISMATCH", "The manifest must match the reserved job, capture and source snapshot.");
  }
  if (manifest.requestedUrl !== conservativeUrlKey(job.source.url)) {
    fail("CAPTURE_URL_MISMATCH", "The requested URL must match the approved source URL.");
  }
  const currentApproval = approvedRuleForUrl(manifest.requestedUrl, configuredPolicy);
  if (!currentApproval || !job.approval || !sameApproval(currentApproval, job.approval) || !sameApproval(currentApproval, manifest.approval)) {
    fail("CAPTURE_APPROVAL_MISMATCH", "The capture requires the current maintainer approval used when claiming the job.");
  }
  if (manifest.fixture !== currentApproval.fixture) fail("CAPTURE_APPROVAL_MISMATCH", "The fixture label must match the source approval.");
  boundedString(manifest.finalUrl, "finalUrl", MAX_SOURCE_URL_LENGTH);
  if (manifest.finalUrl !== conservativeUrlKey(manifest.finalUrl)) fail("CAPTURE_URL_MISMATCH", "The final URL must use its canonical source identity.");
  const finalApproval = approvedRuleForUrl(manifest.finalUrl, configuredPolicy);
  if (!finalApproval || !sameApproval(currentApproval, finalApproval)) fail("REDIRECT_NOT_APPROVED", "The final URL must remain within the requested source's complete maintainer approval.");
  if (manifest.redirects.length > configuredPolicy.maxRedirects) fail("INVALID_CAPTURE", "The capture exceeds the redirect limit.");
  for (const redirect of manifest.redirects) {
    boundedString(redirect, "redirect URL", MAX_SOURCE_URL_LENGTH);
    const redirectApproval = approvedRuleForUrl(redirect, configuredPolicy);
    if (!redirectApproval || !sameApproval(currentApproval, redirectApproval)) fail("REDIRECT_NOT_APPROVED", "Every followed redirect must remain within the requested source's complete maintainer approval.");
  }
  const lastUrl = manifest.redirects.at(-1) ?? manifest.requestedUrl;
  if (manifest.finalUrl !== lastUrl) fail("CAPTURE_URL_MISMATCH", "The final URL must match the recorded redirect chain.");
  if (!isUtcTimestamp(manifest.retrievedAt) || Date.parse(manifest.retrievedAt) > Date.now() + 5 * 60 * 1000) {
    fail("INVALID_CAPTURE", "The retrieval time must be a valid UTC time.");
  }
  if (manifest.http.status !== FULL_CAPTURE_HTTP_STATUS) {
    fail("UNSUPPORTED_HTTP_STATUS", "A complete GET capture requires HTTP 200.");
  }
  boundedString(manifest.http.contentType, "contentType", MAX_HTTP_CONTENT_TYPE_LENGTH);
  if (manifest.http.contentLength !== null) integer(manifest.http.contentLength, "contentLength", 0, MAX_CAPTURE_BYTES);
  if (manifest.http.etag !== null) boundedString(manifest.http.etag, "etag", MAX_HTTP_ETAG_LENGTH, true);
  if (manifest.http.lastModified !== null) boundedString(manifest.http.lastModified, "lastModified", MAX_HTTP_LAST_MODIFIED_LENGTH, true);
  integer(manifest.artifact.byteLength, "byteLength", 0, configuredPolicy.maxBytes);
  if (manifest.http.contentLength !== null && manifest.http.contentLength !== manifest.artifact.byteLength) {
    fail("CAPTURE_LENGTH_MISMATCH", "The declared Content-Length must match the complete captured body.");
  }
  if (manifest.artifact.path !== artifactPathForHash(manifest.artifact.sha256)) {
    fail("INVALID_ARTIFACT_PATH", "The raw artifact path must be derived from its SHA-256 hash.");
  }
  if (!CAPTURE_MEDIA_TYPES.some((mediaType) => mediaType === manifest.artifact.mediaType) || manifest.http.contentType.split(";", 1)[0]?.trim().toLowerCase() !== manifest.artifact.mediaType) {
    fail("UNSUPPORTED_CONTENT_TYPE", "Only matching HTML or text capture media types are supported.");
  }
  boundedString(manifest.completeness, "completeness", MAX_COMPLETENESS_LENGTH);
}

function validatePublication(capture: Doc<"captures">, publication: Publication): void {
  const target = corpusTarget();
  if (publication.owner !== target.owner || publication.repo !== target.repo || publication.branch !== target.branch) {
    fail("PUBLICATION_TARGET_MISMATCH", "Publication must use the configured corpus repository and branch.");
  }
  if (!/^[a-f0-9]{40}$/.test(publication.commitSha)) fail("INVALID_PUBLICATION", "Publication requires an immutable Git commit SHA.");
  if (!capture.manifest || publication.artifactPath !== capture.manifest.artifact.path || publication.manifestPath !== manifestPathForCapture(capture._id)) {
    fail("PUBLICATION_PATH_MISMATCH", "Publication paths must match the staged capture and generated manifest path.");
  }
  const prefix = `https://github.com/${target.owner}/${target.repo}/blob/${publication.commitSha}/`;
  if (publication.artifactUrl !== `${prefix}${publication.artifactPath}` || publication.manifestUrl !== `${prefix}${publication.manifestPath}`) {
    fail("PUBLICATION_REVISION_MISMATCH", "Publication URLs must refer to the verified immutable commit and paths.");
  }
}

export const submitSource = internalMutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    relevance: v.string(),
    series: v.array(seriesValidator),
    idempotencyKey: v.string(),
    reacquire: v.optional(v.boolean()),
  },
  returns: submissionResultValidator,
  handler: async (ctx, args) => {
    boundedString(args.url, "url", MAX_SOURCE_URL_LENGTH);
    boundedString(args.relevance, "relevance", MAX_SOURCE_RELEVANCE_LENGTH);
    boundedString(args.idempotencyKey, "idempotencyKey", 128);
    if (args.title !== undefined) boundedString(args.title, "title", MAX_SOURCE_TITLE_LENGTH);
    if (args.series.length < MIN_SOURCE_SERIES || args.series.length > MAX_SOURCE_SERIES || new Set(args.series).size !== args.series.length) {
      fail("INVALID_INPUT", "series must contain one or two distinct supported BMW series.");
    }
    const urlKey = conservativeUrlKey(args.url);
    const requestFingerprint = JSON.stringify({ url: args.url, title: args.title ?? null, relevance: args.relevance, series: args.series, reacquire: args.reacquire ?? false });
    const priorSubmission = await ctx.db.query("submissions").withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (priorSubmission) {
      if (priorSubmission.requestFingerprint !== requestFingerprint) fail("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different source data.");
      return priorSubmission.result;
    }

    let source = await ctx.db.query("sources").withIndex("by_urlKey", (q) => q.eq("urlKey", urlKey)).unique();
    const wasKnown = source !== null;
    if (!source) {
      const sourceId = await ctx.db.insert("sources", { urlKey, url: args.url, ...(args.title !== undefined ? { title: args.title } : {}), relevance: args.relevance, series: args.series });
      source = await ctx.db.get("sources", sourceId);
    }
    if (!source) fail("SOURCE_NOT_FOUND", "The source could not be recorded.");
    let result: Infer<typeof submissionResultValidator>;
    if (wasKnown && !args.reacquire) {
      result = { sourceId: source._id, jobId: source.latestJobId ?? null, status: "known", reason: "This URL is already recorded. Use an explicit reacquisition or retry to acquire it again." };
    } else if (!approvedRuleForUrl(args.url, policy())) {
      result = { sourceId: source._id, jobId: null, status: "deferred", reason: "Recorded as a reference. Acquisition requires a maintainer-approved redistribution policy." };
    } else {
      const sourceSnapshot = { id: source._id, url: source.url, ...(source.title !== undefined ? { title: source.title } : {}), relevance: source.relevance, series: source.series };
      const jobId = await ctx.db.insert("jobs", { sourceId: source._id, source: sourceSnapshot, status: "queued", phase: "queued", attempt: 0, queuedAt: Date.now() });
      await ctx.db.patch("sources", source._id, { latestJobId: jobId });
      result = { sourceId: source._id, jobId, status: "accepted", reason: null };
    }
    await ctx.db.insert("submissions", { idempotencyKey: args.idempotencyKey, requestFingerprint, result });
    return result;
  },
});

export const getConfiguration = internalQuery({
  args: {},
  returns: v.object({
    workerMode: v.literal("developer"),
    policy: collectionPolicyValidator,
    corpus: v.object({ owner: v.string(), repo: v.string(), branch: v.string() }),
    configuration: v.array(v.object({ name: v.string(), configured: v.boolean() })),
  }),
  handler: async () => ({
    workerMode: "developer" as const,
    policy: policy(),
    corpus: corpusTarget(),
    configuration: CONFIGURATION_NAMES.map((name) => ({ name, configured: env[name] !== undefined && env[name] !== "" })),
  }),
});

export const listJobs = internalQuery({
  args: { limit: v.number() },
  returns: v.array(schema.doc("jobs")),
  handler: async (ctx, args) => {
    integer(args.limit, "limit", 1, 100);
    return await ctx.db.query("jobs").withIndex("by_creation_time").order("desc").take(args.limit);
  },
});

export const getStatus = internalQuery({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.null(), v.object({ job: schema.doc("jobs"), source: schema.doc("sources"), capture: v.union(schema.doc("captures"), v.null()), artifact: v.union(schema.doc("artifacts"), v.null()), processing: v.array(schema.doc("processingResults")) })),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) return null;
    const source = await ctx.db.get("sources", job.sourceId);
    if (!source) fail("SOURCE_NOT_FOUND", "The job source does not exist.");
    const capture = job.captureId ? await ctx.db.get("captures", job.captureId) : null;
    const artifact = capture?.artifactId ? await ctx.db.get("artifacts", capture.artifactId) : null;
    const processing = capture ? await ctx.db.query("processingResults").withIndex("by_captureId", (q) => q.eq("captureId", capture._id)).order("desc").take(10) : [];
    return { job, source, capture, artifact, processing };
  },
});

export const claimJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.union(v.null(), v.object({
    request: v.object({ source: sourceMetadataValidator, jobId: v.string(), captureId: v.string() }),
    attempt: v.number(),
    manifest: v.union(captureManifestValidator, v.null()),
  })),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) fail("JOB_NOT_FOUND", "The collection job does not exist.");
    if (job.status !== "queued") return null;
    const approval = approvedRuleForUrl(job.source.url, policy());
    if (!approval) {
      await ctx.db.patch("jobs", job._id, { status: "skipped", finishedAt: Date.now(), error: { code: "SOURCE_NOT_APPROVED", message: "The source approval is absent. The source was not acquired.", at: Date.now() } });
      return null;
    }
    let captureId = job.captureId;
    if (!captureId) captureId = await ctx.db.insert("captures", { jobId: job._id, sourceId: job.sourceId, status: "reserved", stagingRetention: "retain" });
    const capture = await ctx.db.get("captures", captureId);
    if (!capture || capture.jobId !== job._id || capture.sourceId !== job.sourceId) fail("CAPTURE_NOT_RESERVED", "The capture does not match this job.");
    const attempt = job.attempt + 1;
    await ctx.db.patch("jobs", job._id, { captureId, attempt, approval, status: "running", phase: capture.manifest ? "staged" : "acquiring", startedAt: Date.now(), finishedAt: undefined, error: undefined });
    return { request: { source: job.source, jobId: job._id, captureId }, attempt, manifest: capture.manifest ?? null };
  },
});

export const retryJob = internalMutation({
  args: { jobId: v.id("jobs") },
  returns: v.object({ jobId: v.id("jobs"), status: v.literal("queued") }),
  handler: async (ctx, args) => {
    const job = await ctx.db.get("jobs", args.jobId);
    if (!job) fail("JOB_NOT_FOUND", "The collection job does not exist.");
    if (job.status === "queued") return { jobId: job._id, status: "queued" as const };
    if (job.status !== "failed" && !(job.status === "running" && job.startedAt !== undefined && Date.now() - job.startedAt >= RECOVERY_AFTER_MS)) {
      fail("JOB_NOT_RETRYABLE", "Retry a failed job, or recover a running job after its 15-minute safety window.");
    }
    const capture = job.captureId ? await ctx.db.get("captures", job.captureId) : null;
    await ctx.db.patch("jobs", job._id, { status: "queued", phase: capture?.manifest ? "staged" : "queued", queuedAt: Date.now(), startedAt: undefined, finishedAt: undefined, error: undefined });
    return { jobId: job._id, status: "queued" as const };
  },
});

export const recordStagedCapture = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number(), manifest: captureManifestValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await runningJob(ctx, args.jobId, args.attempt);
    const capture = await reservedCapture(ctx, job);
    validateManifest(job, capture, args.manifest);
    if (capture.manifest && canonicalJson(capture.manifest) !== canonicalJson(args.manifest)) {
      fail("CAPTURE_IMMUTABLE", "A reserved capture cannot be replaced with different bytes or provenance.");
    }
    const priorArtifact = await ctx.db.query("artifacts").withIndex("by_sha256", (q) => q.eq("sha256", args.manifest.artifact.sha256)).unique();
    if (priorArtifact && (priorArtifact.byteLength !== args.manifest.artifact.byteLength || priorArtifact.path !== args.manifest.artifact.path)) {
      fail("ARTIFACT_IDENTITY_MISMATCH", "The recorded content hash has different artifact metadata.");
    }
    const artifactId = priorArtifact?._id ?? await ctx.db.insert("artifacts", { sha256: args.manifest.artifact.sha256, byteLength: args.manifest.artifact.byteLength, path: args.manifest.artifact.path });
    await ctx.db.patch("captures", capture._id, { manifest: args.manifest, artifactId, status: "staged" });
    await ctx.db.patch("jobs", job._id, { phase: "staged" });
    return null;
  },
});

export const recordPublished = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number(), publication: publicationValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("jobs", args.jobId);
    if (existing?.status === "succeeded" && existing.attempt === args.attempt && existing.captureId) {
      const completedCapture = await ctx.db.get("captures", existing.captureId);
      if (completedCapture?.publication && canonicalJson(completedCapture.publication) === canonicalJson(args.publication)) return null;
    }
    const job = await runningJob(ctx, args.jobId, args.attempt);
    const capture = await reservedCapture(ctx, job);
    if (!capture.manifest || !capture.artifactId || job.phase !== "staged") fail("CAPTURE_NOT_STAGED", "Persist a staged capture before recording publication.");
    validateManifest(job, capture, capture.manifest);
    validatePublication(capture, args.publication);
    if (capture.publication && canonicalJson(capture.publication) !== canonicalJson(args.publication)) fail("PUBLICATION_IMMUTABLE", "A capture's publication cannot be replaced with another revision.");
    await ctx.db.patch("captures", capture._id, { status: "published", publication: args.publication });
    await ctx.db.patch("jobs", job._id, { status: "succeeded", phase: "published", finishedAt: Date.now(), error: undefined });
    return null;
  },
});

export const recordFailed = internalMutation({
  args: { jobId: v.id("jobs"), attempt: v.number(), code: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    boundedString(args.code, "error code", 80);
    boundedString(args.message, "error message", 1000);
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(args.code)) fail("INVALID_INPUT", "Failure codes must be safe uppercase identifiers.");
    const job = await runningJob(ctx, args.jobId, args.attempt);
    // Never persist arbitrary SDK or HTTP exception text, which may carry tokens
    // or private response bodies. The phase and safe code retain the diagnosis.
    const message = `Collection failed during ${job.phase} (${args.code}). Any staged source bytes are retained for retry.`;
    await ctx.db.patch("jobs", job._id, { status: "failed", finishedAt: Date.now(), error: { code: args.code, message, at: Date.now() } });
    return null;
  },
});
