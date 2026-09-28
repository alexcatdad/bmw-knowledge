// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CollectionError,
  collectApprovedSource,
  createWorkerPublisher,
  createWorkerStaging,
  GitHubPublisher,
  S3Staging,
  validateStoredCapture,
  type GitHubPublication,
  type StoredCapture,
} from "@bmw-knowledge/collection";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import schema from "./schema";

// These spies delegate to the real factory and collector. Only the two storage
// transports are replaced; collector policy/bytes/checkpoint logic stays real.
vi.mock("@bmw-knowledge/collection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bmw-knowledge/collection")>();
  return { ...actual, createWorkerPublisher: vi.fn(actual.createWorkerPublisher), createWorkerStaging: vi.fn(actual.createWorkerStaging), collectApprovedSource: vi.fn(actual.collectApprovedSource) };
});

const modules = import.meta.glob("./**/*.ts");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const APPROVAL = { origin: "https://example.com", pathPrefix: "/approved", approvedBy: "Maintainer test fixture", basis: "Synthetic owned bytes; plumbing fixture only.", approvedAt: "2026-09-28T11:00:00.000Z", fixture: true };
const SOURCE = { url: "https://example.com/approved/source.txt", title: "Action fixture", relevance: "Test acquisition provenance for E30.", series: ["E30" as const], idempotencyKey: "action-source" };
const BODY = "Synthetic full response bytes from a controlled test.";
const staged = new Map<string, StoredCapture>();
function backend() { return convexTest(schema, modules); }
type Backend = ReturnType<typeof backend>;

async function acceptedJob(t: Backend, overrides: Partial<typeof SOURCE> = {}) {
  const result = await t.mutation(internal.collection.submitSource, { ...SOURCE, ...overrides });
  if (result.jobId === null) throw new Error("Expected an approved fixture job.");
  return result.jobId;
}

async function schedules(t: Backend) {
  return await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").withIndex("by_creation_time").take(20));
}

function publicationFor(capture: StoredCapture): GitHubPublication {
  const artifactPath = capture.manifest.artifact.path;
  const manifestPath = `captures/${capture.manifest.captureId}.json`;
  const commitSha = "f".repeat(40);
  const prefix = `https://github.com/alexcatdad/bmw-corpus/blob/${commitSha}/`;
  return { owner: "alexcatdad", repo: "bmw-corpus", branch: "main", commitSha, artifactPath, manifestPath, artifactUrl: prefix + artifactPath, manifestUrl: prefix + manifestPath };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
  const configuration = {
    COLLECTION_MAX_BYTES: undefined, COLLECTION_TIMEOUT_MS: undefined, COLLECTION_EXECUTION_MODE: "developer", COLLECTION_STAGING_BACKEND: "s3",
    CORPUS_GITHUB_OWNER: undefined, CORPUS_GITHUB_REPO: undefined, CORPUS_GITHUB_BRANCH: undefined,
    CORPUS_GITHUB_TOKEN: "fixture-corpus-token-never-returned", S3_ENDPOINT: "http://minio.private.test:9000",
    S3_BUCKET: "bmw-kb-captures", S3_REGION: "us-east-1", S3_ACCESS_KEY_ID: "bmw-kb-fixture",
    S3_SECRET_ACCESS_KEY: "fixture-s3-secret-never-returned", S3_FORCE_PATH_STYLE: "true",
  };
  for (const [name, value] of Object.entries(configuration)) vi.stubEnv(name, value);
  staged.clear();
  vi.mocked(createWorkerPublisher).mockClear();
  vi.mocked(createWorkerStaging).mockClear();
  vi.mocked(collectApprovedSource).mockClear();
  vi.spyOn(S3Staging.prototype, "load").mockImplementation(async (captureId) => structuredClone(staged.get(captureId) ?? null));
  vi.spyOn(S3Staging.prototype, "save").mockImplementation(async (capture) => {
    const verified = validateStoredCapture(capture);
    staged.set(verified.manifest.captureId, structuredClone(verified));
  });
  vi.spyOn(GitHubPublisher.prototype, "publish").mockImplementation(async (capture) => publicationFor(validateStoredCapture(capture)));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(BODY, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(new TextEncoder().encode(BODY).byteLength) } })));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("transactional acquisition execution mode", () => {
  test("defaults to Convex execution and native staging; explicit modes and presence are reported safely", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", undefined);
    vi.stubEnv("COLLECTION_STAGING_BACKEND", undefined);
    await acceptedJob(t);
    expect(await schedules(t)).toHaveLength(1);
    const defaultConfiguration = await t.query(internal.collection.getConfiguration, {});
    expect(defaultConfiguration.workerMode).toBe("convex");
    expect(defaultConfiguration.stagingBackend).toBe("convex");
    expect(defaultConfiguration.configuration).toContainEqual({ name: "COLLECTION_EXECUTION_MODE", configured: false });
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "developer");
    vi.stubEnv("COLLECTION_STAGING_BACKEND", "s3");
    const convexConfiguration = await t.query(internal.collection.getConfiguration, {});
    expect(convexConfiguration.workerMode).toBe("developer");
    expect(convexConfiguration.stagingBackend).toBe("s3");
    expect(convexConfiguration.configuration).toContainEqual({ name: "COLLECTION_EXECUTION_MODE", configured: true });
    expect(JSON.stringify(convexConfiguration)).not.toMatch(/fixture-corpus-token|fixture-s3-secret|minio.private.test/);
    for (const mode of ["", "Convex", "convex ", "arbitrary-private-marker"]) {
      vi.stubEnv("COLLECTION_EXECUTION_MODE", mode);
      await expect(t.query(internal.collection.getConfiguration, {})).rejects.toThrow("developer or convex");
    }
  });

  test("only a new accepted job schedules; replay, known URLs and deferred references do not", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    const [first, replay] = await Promise.all([t.mutation(internal.collection.submitSource, SOURCE), t.mutation(internal.collection.submitSource, SOURCE)]);
    expect(replay).toEqual(first);
    await t.mutation(internal.collection.submitSource, { ...SOURCE, idempotencyKey: "known-url" });
    await t.mutation(internal.collection.submitSource, { ...SOURCE, url: "https://example.org/reference-only", idempotencyKey: "unapproved-reference" });
    expect(await schedules(t)).toMatchObject([{ name: "acquisition:run", args: [{ jobId: first.jobId }], state: { kind: "pending" } }]);
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, relevance: "changed" })).rejects.toThrow("different source data");
    expect(await schedules(t)).toHaveLength(1);
    await t.mutation(internal.collection.submitSource, { ...SOURCE, idempotencyKey: "explicit-reacquisition", reacquire: true });
    expect(await schedules(t)).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("job, submission and scheduled action roll back together on an enclosing mutation failure", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    await expect(t.mutation(async (ctx) => {
      await ctx.runMutation(internal.collection.submitSource, SOURCE);
      throw new Error("A later atomic mutation step failed.");
    })).rejects.toThrow("later atomic");
    expect(await schedules(t)).toEqual([]);
    expect(await t.query(internal.collection.listJobs, { limit: 10 })).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query("sources").withIndex("by_urlKey", (q) => q.eq("urlKey", SOURCE.url)).take(1))).toEqual([]);
    await acceptedJob(t);
    expect(await schedules(t)).toHaveLength(1);
  });

  test("only a real failed or expired-running retry transition schedules once", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected the fixture claim.");
    await t.mutation(internal.collection.recordFailed, { jobId, attempt: claim.attempt, code: "WORKER_FAILED", message: "Safe fixture failure." });
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    const [first, replay] = await Promise.all([t.mutation(internal.collection.retryJob, { jobId }), t.mutation(internal.collection.retryJob, { jobId })]);
    expect(replay).toEqual(first);
    expect(await schedules(t)).toHaveLength(1);
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await schedules(t)).toHaveLength(1);
    const next = await t.mutation(internal.collection.claimJob, { jobId });
    if (!next) throw new Error("Expected the retry claim.");
    await expect(t.mutation(internal.collection.retryJob, { jobId })).rejects.toThrow("15-minute safety window");
    await t.run(async (ctx) => await ctx.db.patch("jobs", jobId, { startedAt: NOW.getTime() - 15 * 60 * 1000 }));
    await t.mutation(internal.collection.retryJob, { jobId });
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await schedules(t)).toHaveLength(2);
    expect((await t.query(internal.collection.getStatus, { jobId }))?.job.attempt).toBe(next.attempt);
  });

  test("invalid mode rejects a new accepted job atomically without source or schedule residue", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "invalid-private-mode-marker");
    await expect(acceptedJob(t)).rejects.toThrow("developer or convex");
    expect(await schedules(t)).toEqual([]);
    expect(await t.query(internal.collection.listJobs, { limit: 10 })).toEqual([]);
    expect(await t.run(async (ctx) => await ctx.db.query("sources").withIndex("by_urlKey", (q) => q.eq("urlKey", SOURCE.url)).take(1))).toEqual([]);
  });
});

describe("internal Convex Node acquisition action", () => {
  test("developer mode returns disabled without claiming or starting adapter/source IO", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: false, status: "disabled" });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "queued", attempt: 0 }, capture: null });
    expect(createWorkerStaging).not.toHaveBeenCalled();
    expect(createWorkerPublisher).not.toHaveBeenCalled();
    expect(collectApprovedSource).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(S3Staging.prototype.load).not.toHaveBeenCalled();
  });

  test("scheduled action uses the same collector and checkpoints real staged provenance before publication", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockImplementationOnce(async (capture) => {
      const state = await t.query(internal.collection.getStatus, { jobId });
      expect(state).toMatchObject({ job: { status: "running", phase: "staged", attempt: 1 }, capture: { status: "staged", manifest: capture.manifest, stagingRetention: "retain" } });
      expect(staged.get(capture.manifest.captureId)).toEqual(capture);
      return publicationFor(capture);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status).toMatchObject({ job: { status: "succeeded", phase: "published", attempt: 1 }, capture: { status: "published", stagingRetention: "retain", manifest: { fixture: true, source: { url: SOURCE.url } }, publication: { commitSha: "f".repeat(40) } } });
    expect(collectApprovedSource).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(createWorkerStaging).mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(collectApprovedSource).mock.calls[0]?.[1].signal).toBe(signal);
    expect(signal?.aborted).toBe(true);
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: false, status: "not_claimed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("missing adapter configuration becomes a visible claimed failure and can be retried", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    vi.stubEnv("S3_BUCKET", undefined);
    const failed = await t.action(internal.acquisition.run, { jobId });
    expect(failed).toEqual({ jobId, claimed: true, status: "failed", errorCode: "WORKER_CONFIGURATION" });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "failed", attempt: 1, error: { code: "WORKER_CONFIGURATION" } }, capture: { status: "reserved" } });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv("S3_BUCKET", "bmw-kb-captures");
    await t.mutation(internal.collection.retryJob, { jobId });
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await schedules(t)).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.collection.getStatus, { jobId }))?.job).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  test.each(["approvals", "limits"] as const)("invalid %s at claim leaves a failed job without capture and repair schedules exactly once", async (setting) => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    if (setting === "approvals") vi.stubEnv("COLLECTION_APPROVALS_JSON", "private-malformed-policy-marker");
    else vi.stubEnv("COLLECTION_MAX_BYTES", "private-invalid-limit-marker");
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: false, status: "failed", errorCode: "WORKER_CONFIGURATION" });
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status).toMatchObject({ job: { status: "failed", attempt: 0, finishedAt: NOW.getTime(), error: { code: "WORKER_CONFIGURATION" } }, capture: null });
    expect(JSON.stringify(status)).not.toContain("private-");
    expect(createWorkerStaging).not.toHaveBeenCalled();
    vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
    vi.stubEnv("COLLECTION_MAX_BYTES", undefined);
    await t.mutation(internal.collection.retryJob, { jobId });
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await schedules(t)).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(internal.collection.getStatus, { jobId }))?.job.status).toBe("succeeded");
  });

  test("revoked approval still skips without reserving or fetching a capture", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    vi.stubEnv("COLLECTION_APPROVALS_JSON", undefined);
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: false, status: "not_claimed" });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "skipped", error: { code: "SOURCE_NOT_APPROVED" } }, capture: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("publication failure is safe and retry resumes original staged bytes without refetching", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "private-token-provider-body-marker"));
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: true, status: "failed", errorCode: "GITHUB_WRITE_FAILED" });
    const before = await t.query(internal.collection.getStatus, { jobId });
    expect(before).toMatchObject({ job: { status: "failed", phase: "staged" }, capture: { status: "staged", stagingRetention: "retain" } });
    expect(JSON.stringify(before)).not.toMatch(/private-token-provider-body-marker|fixture-corpus-token|fixture-s3-secret/);
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: true, status: "succeeded" });
    const after = await t.query(internal.collection.getStatus, { jobId });
    expect(after?.capture?._id).toBe(before?.capture?._id);
    expect(after?.capture?.manifest).toEqual(before?.capture?.manifest);
    expect(vi.mocked(collectApprovedSource).mock.calls[1]?.[1].expectedManifest).toEqual(before?.capture?.manifest);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(S3Staging.prototype.save).toHaveBeenCalledTimes(1);
  });

  test("unknown SDK exception text and attacker-chosen error codes never reach output or durable state", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    vi.mocked(S3Staging.prototype.load).mockRejectedValueOnce(new CollectionError("PRIVATE_SECRET_CODE_MARKER", "private-upstream-body-marker"));
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: true, status: "failed", errorCode: "WORKER_FAILED" });
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status?.job.error?.code).toBe("WORKER_FAILED");
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE_SECRET_CODE_MARKER|private-upstream-body-marker/);
  });

  test("a lost publication acknowledgement preserves the committed success", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    const { run } = await import("./acquisition");
    // Convex exposes this test hook at runtime but strips its @internal type
    // from the published declarations. Keep the narrow shape fully typed.
    const handler = (run as typeof run & { _handler: (ctx: ActionCtx, args: { jobId: Id<"jobs"> }) => Promise<FunctionReturnType<typeof internal.acquisition.run>> })._handler;
    const result = await t.action(async (ctx) => {
      const original = ctx.runMutation.bind(ctx);
      vi.spyOn(ctx, "runMutation").mockImplementation(async (...parameters) => {
        const result = await original(parameters[0], parameters[1] ?? {});
        if (getFunctionName(parameters[0]) === "collection:recordPublished") throw new Error("private-lost-ack-marker");
        return result;
      });
      return await handler(ctx, { jobId });
    });
    expect(result).toEqual({ jobId, claimed: true, status: "succeeded" });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "succeeded", phase: "published" }, capture: { status: "published" } });
  });

  test("late publication/failure from a manually recovered attempt cannot overwrite the current attempt", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    let replacementAttempt = 0;
    vi.mocked(GitHubPublisher.prototype.publish).mockImplementationOnce(async (capture) => {
      await t.run(async (ctx) => await ctx.db.patch("jobs", jobId, { startedAt: NOW.getTime() - 15 * 60 * 1000 }));
      await t.mutation(internal.collection.retryJob, { jobId });
      const claimed = await t.mutation(internal.collection.claimJob, { jobId });
      if (!claimed) throw new Error("Expected the replacement claim.");
      replacementAttempt = claimed.attempt;
      return publicationFor(capture);
    });
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: true, status: "failed", errorCode: "STALE_WORKER_ATTEMPT" });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "running", attempt: replacementAttempt, phase: "staged" }, capture: { status: "staged" } });
  });

  test("the shared eight-minute signal aborts in-flight work and records a visible bounded timeout", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    let entered: () => void = () => { throw new Error("Test entry not initialized."); };
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let operationAborted = false;
    vi.mocked(S3Staging.prototype.load).mockImplementationOnce(async () => {
      const signal = vi.mocked(createWorkerStaging).mock.calls.at(-1)?.[1]?.signal;
      if (!signal) throw new Error("Expected the action-wide signal.");
      entered();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => {
        operationAborted = true;
        reject(new Error("private-timeout-reason-marker"));
      }, { once: true }));
    });
    const pending = t.action(internal.acquisition.run, { jobId });
    await started;
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect(await pending).toEqual({ jobId, claimed: true, status: "failed", errorCode: "WORKER_TIMEOUT" });
    expect(operationAborted).toBe(true);
    expect(vi.mocked(collectApprovedSource).mock.calls[0]?.[1].signal).toBe(vi.mocked(createWorkerStaging).mock.calls[0]?.[1]?.signal);
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status).toMatchObject({ job: { status: "failed", error: { code: "WORKER_TIMEOUT" } }, capture: { status: "reserved" } });
    expect(JSON.stringify(status)).not.toContain("private-timeout-reason-marker");
    expect(fetch).not.toHaveBeenCalled();
    expect(GitHubPublisher.prototype.publish).not.toHaveBeenCalled();
  });
});

describe("credential-free Convex Node MinIO health probe", () => {
  test("missing or malformed maintained endpoints perform no network IO and return no configuration value", async () => {
    const t = backend();
    vi.stubEnv("S3_ENDPOINT", undefined);
    expect(await t.action(internal.acquisition.probeMinio, {})).toEqual({ runtime: "convex-node", endpointConfigured: false, reachable: false, httpStatus: null, errorCode: "ENDPOINT_NOT_CONFIGURED" });
    for (const endpoint of ["not-an-endpoint-private-marker", "ftp://minio.private.test", "http://credential:private-marker@minio.private.test:9000", "http://minio.private.test:9000/prefix", "http://minio.private.test:9000?private-marker=1", "http://minio.private.test:9000/#private-marker"]) {
      vi.stubEnv("S3_ENDPOINT", endpoint);
      const result = await t.action(internal.acquisition.probeMinio, {});
      expect(result).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: false, httpStatus: null, errorCode: "INVALID_ENDPOINT" });
      expect(JSON.stringify(result)).not.toMatch(/private-marker|minio.private.test/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  test("probe reads only the fixed health path without redirects, headers, credentials or response body", async () => {
    const t = backend();
    let bodyRead = false;
    let bodyCanceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() { bodyRead = true; throw new Error("The probe must not read private body content."); },
      cancel() { bodyCanceled = true; },
    }, { highWaterMark: 0 });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(body, { status: 200 }));
    expect(await t.action(internal.acquisition.probeMinio, {})).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: true, httpStatus: 200, errorCode: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toBe("http://minio.private.test:9000/minio/health/live");
    expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    expect(options).not.toHaveProperty("headers");
    expect(options).not.toHaveProperty("credentials");
    expect(options).not.toHaveProperty("body");
    expect(bodyRead).toBe(false);
    expect(bodyCanceled).toBe(true);
  });

  test("failed and non-healthy HTTP responses expose only fixed codes and bounded status", async () => {
    const t = backend();
    vi.mocked(fetch).mockRejectedValueOnce(new Error("private-network-endpoint-token-marker"));
    expect(await t.action(internal.acquisition.probeMinio, {})).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: false, httpStatus: null, errorCode: "PROBE_FAILED" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response("private-service-body-marker", { status: 503 }));
    expect(await t.action(internal.acquisition.probeMinio, {})).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: false, httpStatus: 503, errorCode: "MINIO_UNHEALTHY" });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://unrelated-private.example/" } }));
    expect(await t.action(internal.acquisition.probeMinio, {})).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: false, httpStatus: 302, errorCode: "MINIO_UNHEALTHY" });
  });

  test("probe aborts the actual request at five seconds and does not surface abort reasons", async () => {
    const t = backend();
    let entered: () => void = () => { throw new Error("Test entry not initialized."); };
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    vi.mocked(fetch).mockImplementationOnce(async (_url, options) => {
      if (!options?.signal) throw new Error("Expected a probe signal.");
      const signal = options.signal;
      entered();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("private-abort-marker")); }, { once: true }));
    });
    const pending = t.action(internal.acquisition.probeMinio, {});
    await started;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual({ runtime: "convex-node", endpointConfigured: true, reachable: false, httpStatus: null, errorCode: "PROBE_TIMEOUT" });
    expect(aborted).toBe(true);
  });
});
