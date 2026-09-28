// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { getFunctionName, type FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CollectionError, GitHubPublisher, manifestBytes, sha256Bytes, type GitHubPublication, type StoredCapture } from "@bmw-knowledge/collection";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { NativeStaging } from "./nativeStaging";
import schema from "./schema";
import { storageHashHex } from "./storageChecks";

const modules = import.meta.glob("./**/*.ts");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const APPROVAL = { origin: "https://example.com", pathPrefix: "/approved", approvedBy: "Maintainer test fixture", basis: "Owned synthetic bytes, plumbing proof only.", approvedAt: "2026-09-28T11:00:00.000Z", fixture: true };
const SOURCE = { url: "https://example.com/approved/native.txt", title: "Native storage fixture", relevance: "Synthetic E30 provenance fixture.", series: ["E30" as const], idempotencyKey: "native-source" };
const BODY = "Synthetic original response bytes retained by native storage.";
const BYTES = new TextEncoder().encode(BODY);
function backend() { return convexTest(schema, modules); }
type Backend = ReturnType<typeof backend>;

async function acceptedJob(t: Backend, overrides: Partial<typeof SOURCE> = {}) {
  const result = await t.mutation(internal.collection.submitSource, { ...SOURCE, ...overrides });
  if (!result.jobId) throw new Error("Expected the approved fixture job.");
  return result.jobId;
}

async function retained(t: Backend, jobId: Id<"jobs">) {
  const status = await t.query(internal.collection.getStatus, { jobId });
  const capture = status?.capture;
  if (!status || !capture?.manifest || !capture.storageId) throw new Error("Expected a retained native checkpoint.");
  return { status, capture, manifest: capture.manifest, storageId: capture.storageId };
}

async function files(t: Backend) {
  return await t.run(async (ctx) => await ctx.db.system.query("_storage").withIndex("by_creation_time").take(20));
}

function publicationFor(capture: StoredCapture): GitHubPublication {
  const artifactPath = capture.manifest.artifact.path;
  const manifestPath = `captures/${capture.manifest.captureId}.json`;
  const commitSha = "f".repeat(40);
  const prefix = `https://github.com/alexcatdad/bmw-corpus/blob/${commitSha}/`;
  return { owner: "alexcatdad", repo: "bmw-corpus", branch: "main", commitSha, artifactPath, manifestPath, artifactUrl: prefix + artifactPath, manifestUrl: prefix + manifestPath };
}

async function runWithContext(t: Backend, jobId: Id<"jobs">, configure: (ctx: ActionCtx) => void) {
  const { run } = await import("./acquisition");
  // The framework's runtime test hook is omitted from published declarations.
  const handler = (run as typeof run & { _handler: (ctx: ActionCtx, args: { jobId: Id<"jobs"> }) => Promise<FunctionReturnType<typeof internal.acquisition.run>> })._handler;
  return await t.action(async (ctx) => {
    configure(ctx);
    return await handler(ctx, { jobId });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
  for (const name of ["COLLECTION_EXECUTION_MODE", "COLLECTION_STAGING_BACKEND", "COLLECTION_MAX_BYTES", "COLLECTION_TIMEOUT_MS", "CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"]) vi.stubEnv(name, undefined);
  vi.stubEnv("CORPUS_GITHUB_TOKEN", "fixture-publisher-token-never-returned");
  vi.spyOn(GitHubPublisher.prototype, "publish").mockImplementation(async (capture) => publicationFor(capture));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(BODY, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(BYTES.byteLength) } })));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("native retained capture staging", () => {
  test("default native action retains verified original bytes before a missing publisher credential fails", async () => {
    const t = backend();
    vi.stubEnv("CORPUS_GITHUB_TOKEN", undefined);
    const jobId = await acceptedJob(t);
    expect(await t.query(internal.collection.getConfiguration, {})).toMatchObject({ workerMode: "convex", stagingBackend: "convex" });
    expect(await t.action(internal.acquisition.run, { jobId })).toEqual({ jobId, claimed: true, status: "failed", errorCode: "WORKER_CONFIGURATION" });
    const saved = await retained(t, jobId);
    expect(saved.status).toMatchObject({ job: { status: "failed", phase: "staged" }, capture: { status: "staged", stagingBackend: "convex", stagingRetention: "retain" } });
    expect(saved.capture.publication).toBeUndefined();
    expect(saved.manifest.artifact).toMatchObject({ sha256: sha256Bytes(BYTES), byteLength: BYTES.byteLength });
    const storedBytes = await t.action(async (ctx) => await (await ctx.storage.get(saved.storageId))!.arrayBuffer());
    expect(new Uint8Array(storedBytes)).toEqual(BYTES);
    const inspection = await t.action(internal.acquisition.inspectStaging, { jobId });
    expect(inspection).toEqual({ jobId, stagingBackend: "convex", status: "verified", verified: true, byteLength: BYTES.byteLength, sha256: sha256Bytes(BYTES), fixture: true, retention: "retain", metadataHashEncoding: "base64", errorCode: null });
    expect(JSON.stringify(inspection)).not.toContain(saved.storageId);
    expect(JSON.stringify(inspection)).not.toMatch(/storageId|_storage|https?:|fixture-publisher-token/);
    expect(await files(t)).toHaveLength(1);
    expect(GitHubPublisher.prototype.publish).not.toHaveBeenCalled();
  });

  test("retry uses the exact file and immutable manifest without refetching or storing again", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "private-provider-body-marker"));
    expect(await t.action(internal.acquisition.run, { jobId })).toMatchObject({ status: "failed", errorCode: "GITHUB_WRITE_FAILED" });
    const before = await retained(t, jobId);
    vi.stubEnv("COLLECTION_STAGING_BACKEND", "s3");
    await t.mutation(internal.collection.retryJob, { jobId });
    const store = vi.fn();
    expect(await runWithContext(t, jobId, (ctx) => { vi.spyOn(ctx.storage, "store").mockImplementation(async () => { store(); throw new Error("Retry must not store."); }); })).toEqual({ jobId, claimed: true, status: "succeeded" });
    const after = await retained(t, jobId);
    expect(after.storageId).toBe(before.storageId);
    expect(after.capture._id).toBe(before.capture._id);
    expect(manifestBytes(after.manifest)).toEqual(manifestBytes(before.manifest));
    expect(after.capture.stagingBackend).toBe("convex");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store).not.toHaveBeenCalled();
    expect(await files(t)).toHaveLength(1);
    expect(JSON.stringify(after.status)).not.toContain("private-provider-body-marker");
  });

  test("equal raw bytes share one verified native blob while keeping distinct capture contexts", async () => {
    const t = backend();
    const first = await acceptedJob(t);
    const second = await acceptedJob(t, { url: "https://example.com/approved/other.txt", idempotencyKey: "native-other", title: "Second context" });
    expect(await t.action(internal.acquisition.run, { jobId: first })).toMatchObject({ status: "succeeded" });
    expect(await t.action(internal.acquisition.run, { jobId: second })).toMatchObject({ status: "succeeded" });
    const left = await retained(t, first);
    const right = await retained(t, second);
    expect(left.storageId).toBe(right.storageId);
    expect(left.capture._id).not.toBe(right.capture._id);
    expect(left.manifest.source.url).not.toBe(right.manifest.source.url);
    expect(await files(t)).toHaveLength(1);
  });

  test("legacy S3 reservations remain pinned when the maintained default changes to native storage", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "developer");
    vi.stubEnv("COLLECTION_STAGING_BACKEND", "s3");
    const jobId = await acceptedJob(t);
    const first = await t.mutation(internal.collection.claimJob, { jobId });
    if (!first) throw new Error("Expected an S3 reservation.");
    expect(first.stagingBackend).toBe("s3");
    // A capture created before backend pinning has no field; it is still S3.
    const status = await t.query(internal.collection.getStatus, { jobId });
    if (!status?.capture) throw new Error("Expected the reserved capture.");
    await t.run(async (ctx) => await ctx.db.patch("captures", status.capture!._id, { stagingBackend: undefined }));
    await t.mutation(internal.collection.recordFailed, { jobId, attempt: first.attempt, code: "WORKER_FAILED", message: "Synthetic failure." });
    vi.stubEnv("COLLECTION_STAGING_BACKEND", undefined);
    await t.mutation(internal.collection.retryJob, { jobId });
    const next = await t.mutation(internal.collection.claimJob, { jobId });
    expect(next).toMatchObject({ stagingBackend: "s3", request: { captureId: first.request.captureId } });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ capture: { stagingBackend: "s3" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(await files(t)).toEqual([]);
  });

  test("the native checkpoint rejects mismatched bytes before writes and mismatched file metadata atomically", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    await t.mutation(internal.collection.retryJob, { jobId });
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected the retry claim.");
    await expect(t.action(async (ctx) => {
      const staging = new NativeStaging(ctx, { jobId, captureId: claim.request.captureId, attempt: claim.attempt }, new AbortController().signal);
      await staging.save({ manifest: saved.manifest, bytes: new TextEncoder().encode("corrupted") });
      return null;
    })).rejects.toThrow("bytes");
    expect(await files(t)).toHaveLength(1);
    const wrong = await t.action(async (ctx) => await ctx.storage.store(new Blob(["corrupted"])));
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: saved.manifest, storageId: wrong })).rejects.toThrow("SHA-256 and length");
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
  });

  test("missing retained files fail safely without replacing or refetching source bytes", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    // Only the test deletes its fixture to model external storage loss.
    await t.action(async (ctx) => { await ctx.storage.delete(saved.storageId); return null; });
    expect(await t.action(internal.acquisition.inspectStaging, { jobId })).toMatchObject({ status: "unavailable", verified: false, errorCode: "STORAGE_FILE_MISSING" });
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await t.action(internal.acquisition.run, { jobId })).toMatchObject({ status: "failed", errorCode: "STORAGE_FILE_MISSING" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(GitHubPublisher.prototype.publish).toHaveBeenCalledTimes(1);
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
    expect(await files(t)).toEqual([]);
  });

  test("actual blob hash corruption is rejected even when system metadata still matches the manifest", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    await t.mutation(internal.collection.retryJob, { jobId });
    const wrongBytes = BYTES.slice();
    wrongBytes[0] = wrongBytes[0]! ^ 1;
    expect(await runWithContext(t, jobId, (ctx) => {
      vi.spyOn(ctx.storage, "get").mockResolvedValue(new Blob([wrongBytes.buffer], { type: "text/plain" }));
    })).toMatchObject({ status: "failed", errorCode: "CAPTURE_INTEGRITY_FAILED" });
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(GitHubPublisher.prototype.publish).toHaveBeenCalledTimes(1);
    expect(await files(t)).toHaveLength(1);
  });

  test("native checkpoint and readback guards bind file IDs to the current attempt and immutable capture", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    await t.mutation(internal.collection.retryJob, { jobId });
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected a replacement claim.");
    await expect(t.query(internal.collection.getNativeStagingState, { jobId, attempt: saved.status.job.attempt })).rejects.toThrow("STALE_WORKER_ATTEMPT");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: saved.status.job.attempt, manifest: saved.manifest, storageId: saved.storageId })).rejects.toThrow("STALE_WORKER_ATTEMPT");
    const duplicate = await t.action(async (ctx) => await ctx.storage.store(new Blob([BYTES.slice().buffer])));
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: saved.manifest, storageId: duplicate })).rejects.toThrow("cannot be replaced");
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
    // Deliberate duplicate fixture stays retained; application code never deletes.
    expect(await files(t)).toHaveLength(2);
  });

  test("storage failures never imply a staged or published capture and expose only fixed safe errors", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    expect(await runWithContext(t, jobId, (ctx) => { vi.spyOn(ctx.storage, "store").mockRejectedValueOnce(new Error("private-storage-credential-body-marker")); })).toEqual({ jobId, claimed: true, status: "failed", errorCode: "STAGING_WRITE_FAILED" });
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status).toMatchObject({ job: { status: "failed", phase: "acquiring" }, capture: { status: "reserved", stagingBackend: "convex" }, artifact: null });
    expect(status?.capture?.manifest).toBeUndefined();
    expect(status?.capture?.storageId).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("private-storage-credential-body-marker");
    expect(GitHubPublisher.prototype.publish).not.toHaveBeenCalled();
    expect(await files(t)).toEqual([]);
  });
});

describe("native checkpoint acknowledgement boundaries", () => {
  test("a storage acknowledgement arriving after the deadline is linked before the action records timeout", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "developer");
    const jobId = await acceptedJob(t);
    vi.stubEnv("COLLECTION_EXECUTION_MODE", "convex");
    let entered: () => void = () => { throw new Error("Storage entry not initialized."); };
    let release: () => void = () => { throw new Error("Storage release not initialized."); };
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const pending = runWithContext(t, jobId, (ctx) => {
      const original = ctx.storage.store.bind(ctx.storage);
      vi.spyOn(ctx.storage, "store").mockImplementation(async (blob, options) => {
        const storageId = await original(blob, options);
        entered();
        await delayed;
        return storageId;
      });
    });
    await started;
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.manifest).toBeUndefined();
    release();
    expect(await pending).toEqual({ jobId, claimed: true, status: "failed", errorCode: "WORKER_TIMEOUT" });
    expect(await retained(t, jobId)).toMatchObject({ capture: { status: "staged", stagingRetention: "retain" } });
    expect(await t.action(internal.acquisition.inspectStaging, { jobId })).toMatchObject({ verified: true });
    expect(await files(t)).toHaveLength(1);
    expect(GitHubPublisher.prototype.publish).not.toHaveBeenCalled();
  });

  test("an unknown lost checkpoint acknowledgement recovers the exact durable reference", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    let lost = false;
    expect(await runWithContext(t, jobId, (ctx) => {
      const original = ctx.runMutation.bind(ctx);
      vi.spyOn(ctx, "runMutation").mockImplementation(async (...parameters) => {
        const result = await original(parameters[0], parameters[1] ?? {});
        if (!lost && getFunctionName(parameters[0]) === "collection:recordStagedCapture") { lost = true; throw new Error("private-lost-checkpoint-ack-marker"); }
        return result;
      });
    })).toEqual({ jobId, claimed: true, status: "succeeded" });
    expect(lost).toBe(true);
    expect(await files(t)).toHaveLength(1);
    expect(await t.action(internal.acquisition.inspectStaging, { jobId })).toMatchObject({ verified: true });
  });

  test("an explicit changed approval on a retry cannot be mistaken for a lost acknowledgement", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic first failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    await t.mutation(internal.collection.retryJob, { jobId });
    expect(await runWithContext(t, jobId, (ctx) => {
      const original = ctx.runMutation.bind(ctx);
      vi.spyOn(ctx, "runMutation").mockImplementation(async (...parameters) => {
        if (getFunctionName(parameters[0]) === "collection:recordStagedCapture") vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([{ ...APPROVAL, basis: "Changed approval after loading retained bytes." }]));
        return await original(parameters[0], parameters[1] ?? {});
      });
    })).toMatchObject({ status: "failed", errorCode: "CAPTURE_APPROVAL_MISMATCH" });
    expect(GitHubPublisher.prototype.publish).toHaveBeenCalledTimes(1);
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
  });

  test.each([
    ["COLLECTION_APPROVALS_JSON", "private-invalid-policy-marker"],
    ["COLLECTION_MAX_BYTES", "private-invalid-limit-marker"],
  ])("%s semantic policy errors survive Node syscall transport and prevent retry publication", async (name, value) => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.mocked(GitHubPublisher.prototype.publish).mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Synthetic first failure."));
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    await t.mutation(internal.collection.retryJob, { jobId });
    let typedRejection = false;
    const result = await runWithContext(t, jobId, (ctx) => {
      const original = ctx.runMutation.bind(ctx);
      vi.spyOn(ctx, "runMutation").mockImplementation(async (...parameters) => {
        if (getFunctionName(parameters[0]) === "collection:recordStagedCapture") vi.stubEnv(name, value);
        try { return await original(parameters[0], parameters[1] ?? {}); }
        catch (error) {
          // Hosted runMutation preserves ConvexError data, but other classes
          // cross the runtime syscall as ordinary Error(message).
          if (error instanceof ConvexError) { typedRejection = true; throw new ConvexError(error.data); }
          throw new Error(error instanceof Error ? error.message : "Transport error.");
        }
      });
    });
    expect(result).toMatchObject({ status: "failed", errorCode: "WORKER_CONFIGURATION" });
    expect(typedRejection).toBe(true);
    expect(GitHubPublisher.prototype.publish).toHaveBeenCalledTimes(1);
    expect((await retained(t, jobId)).storageId).toBe(saved.storageId);
    expect(JSON.stringify(result)).not.toContain(value);
  });
});

describe("native metadata and research transport", () => {
  test("only exact hex or canonical 32-byte base64 hash metadata is accepted", () => {
    const hash = sha256Bytes(BYTES);
    const binary = Array.from(hash.match(/../g)!, (pair) => String.fromCharCode(Number.parseInt(pair, 16))).join("");
    expect(storageHashHex(hash)).toBe(hash);
    expect(storageHashHex(btoa(binary))).toBe(hash);
    for (const malformed of [hash.toUpperCase(), hash.slice(2), btoa(binary).slice(0, -1), btoa("short"), "x".repeat(43) + "="]) expect(() => storageHashHex(malformed)).toThrow("SHA-256 and length");
  });

  test("research collection status exposes capture provenance but no native storage IDs or download URLs", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    vi.stubEnv("CORPUS_GITHUB_TOKEN", undefined);
    await t.action(internal.acquisition.run, { jobId });
    const saved = await retained(t, jobId);
    const result = await t.query(internal.research.getCollectionStatus, { sourceIds: [saved.status.source._id] });
    const serialized = JSON.stringify(result);
    expect(serialized).toContain(saved.capture._id);
    expect(serialized).not.toContain(saved.storageId);
    expect(serialized).not.toMatch(/storageId|_storage|download|api\/storage/);
  });
});
