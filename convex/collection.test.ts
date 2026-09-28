// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  conservativeUrlKey,
  FULL_CAPTURE_HTTP_STATUS,
  MAX_COMPLETENESS_LENGTH,
  MAX_HTTP_CONTENT_TYPE_LENGTH,
  MAX_HTTP_ETAG_LENGTH,
  MAX_HTTP_LAST_MODIFIED_LENGTH,
  MAX_SOURCE_RELEVANCE_LENGTH,
  MAX_SOURCE_TITLE_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  validateSourceMetadata,
} from "@bmw-knowledge/collection/policy";
import { validateCaptureManifest } from "../packages/collection/src/manifest";
import type { Infer } from "convex/values";
import { internal } from "./_generated/api";
import schema from "./schema";
import { captureManifestValidator, sourceMetadataValidator } from "./validators";

const modules = import.meta.glob("./**/*.ts");
const NOW = new Date("2026-09-28T12:00:00.000Z");
const APPROVAL = {
  origin: "https://example.com",
  pathPrefix: "/approved",
  approvedBy: "Maintainer test fixture",
  basis: "Synthetic bytes owned by the test author; plumbing test only.",
  approvedAt: "2026-09-28T11:00:00.000Z",
  fixture: true,
};
const SOURCE = {
  url: "https://example.com/approved/source.txt",
  title: "Synthetic collection fixture",
  relevance: "Test collection provenance for the E30 scope.",
  series: ["E30" as const],
  idempotencyKey: "submission-one",
};
type Manifest = Infer<typeof captureManifestValidator>;
type Claim = {
  request: { source: Infer<typeof sourceMetadataValidator>; jobId: string; captureId: string };
  attempt: number;
  manifest: Manifest | null;
};

function backend() {
  return convexTest(schema, modules);
}

async function acceptedJob(t: ReturnType<typeof backend>, overrides: Partial<typeof SOURCE> = {}) {
  const result = await t.mutation(internal.collection.submitSource, { ...SOURCE, ...overrides });
  if (result.jobId === null) throw new Error("The approved fixture should have a collection job.");
  return result.jobId;
}

function manifestFor(claim: Claim, hash = "a".repeat(64)): Manifest {
  return {
    schemaVersion: 1,
    kind: "http_response_capture",
    source: claim.request.source,
    jobId: claim.request.jobId,
    captureId: claim.request.captureId,
    requestedUrl: conservativeUrlKey(claim.request.source.url),
    finalUrl: conservativeUrlKey(claim.request.source.url),
    retrievedAt: NOW.toISOString(),
    http: { status: 200, contentType: "text/plain; charset=utf-8", contentLength: 48, etag: null, lastModified: null },
    redirects: [],
    artifact: { sha256: hash, byteLength: 48, mediaType: "text/plain", path: `raw/sha256/${hash}` },
    approval: APPROVAL,
    fixture: true,
    completeness: "Complete HTTP response body; linked pages and attachments were not acquired.",
  };
}

function publicationFor(manifest: Manifest) {
  const commitSha = "f".repeat(40);
  const prefix = `https://github.com/alexcatdad/bmw-corpus/blob/${commitSha}/`;
  const artifactPath = manifest.artifact.path;
  const manifestPath = `captures/${manifest.captureId}.json`;
  return { owner: "alexcatdad", repo: "bmw-corpus", branch: "main", commitSha, artifactPath, manifestPath, artifactUrl: `${prefix}${artifactPath}`, manifestUrl: `${prefix}${manifestPath}` };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
  vi.stubEnv("COLLECTION_EXECUTION_MODE", "developer");
  vi.stubEnv("COLLECTION_STAGING_BACKEND", "s3");
  for (const name of ["COLLECTION_MAX_BYTES", "COLLECTION_TIMEOUT_MS", "CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH", "CORPUS_GITHUB_TOKEN", "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_FORCE_PATH_STYLE"]) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("maintainer-controlled collection state", () => {
  test("replays an identical submission and rejects a changed payload under the same key", async () => {
    const t = backend();
    const accepted = await t.mutation(internal.collection.submitSource, SOURCE);
    expect(accepted.status).toBe("accepted");
    expect(await t.mutation(internal.collection.submitSource, SOURCE)).toEqual(accepted);
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, relevance: "Different source data" })).rejects.toThrow("different source data");
    expect(await t.query(internal.collection.listJobs, { limit: 10 })).toHaveLength(1);
  });

  test("a new key for a known URL does not acquire again; explicit reacquisition preserves the prior job", async () => {
    const t = backend();
    const first = await t.mutation(internal.collection.submitSource, { ...SOURCE, url: `${SOURCE.url}#first` });
    const known = await t.mutation(internal.collection.submitSource, { ...SOURCE, url: `${SOURCE.url}#second`, idempotencyKey: "known-key" });
    expect(known).toMatchObject({ sourceId: first.sourceId, jobId: first.jobId, status: "known" });
    const reacquired = await t.mutation(internal.collection.submitSource, { ...SOURCE, idempotencyKey: "reacquire-key", reacquire: true });
    expect(reacquired).toMatchObject({ sourceId: first.sourceId, status: "accepted" });
    expect(reacquired.jobId).not.toBe(first.jobId);
    expect(await t.query(internal.collection.listJobs, { limit: 10 })).toHaveLength(2);
  });

  test("unapproved discoveries remain references and callers cannot grant themselves approval", async () => {
    const t = backend();
    vi.stubEnv("COLLECTION_APPROVALS_JSON", undefined);
    const deferred = await t.mutation(internal.collection.submitSource, SOURCE);
    expect(deferred).toMatchObject({ status: "deferred", jobId: null });
    expect(await t.query(internal.collection.listJobs, { limit: 10 })).toEqual([]);
    const injected = { ...SOURCE, idempotencyKey: "injected", approval: APPROVAL };
    await expect(t.mutation(internal.collection.submitSource, injected)).rejects.toThrow();
    const configured = await t.query(internal.collection.getConfiguration, {});
    expect(configured.policy.approvals).toEqual([]);
  });

  test("enforces source, metadata and listing bounds before queueing", async () => {
    const t = backend();
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, url: "http://10.0.10.21/admin" })).rejects.toThrow("HTTPS");
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, relevance: "x".repeat(4001) })).rejects.toThrow("bounded");
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, series: ["E30", "E30"] })).rejects.toThrow("distinct");
    await expect(t.query(internal.collection.listJobs, { limit: 101 })).rejects.toThrow("bounds");
    expect(await t.query(internal.collection.listJobs, { limit: 1 })).toEqual([]);
  });

  test("accepted metadata and HTTP fields at the shared maxima satisfy both backend and library contracts", async () => {
    const t = backend();
    const urlPrefix = "https://example.com/approved/";
    const jobId = await acceptedJob(t, {
      url: `${urlPrefix}${"a".repeat(MAX_SOURCE_URL_LENGTH - urlPrefix.length)}`,
      title: "t".repeat(MAX_SOURCE_TITLE_LENGTH),
      relevance: "r".repeat(MAX_SOURCE_RELEVANCE_LENGTH),
    });
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected boundary claim.");
    expect(validateSourceMetadata(claim.request.source)).toEqual(claim.request.source);
    const contentTypePrefix = "text/plain;";
    const manifest = {
      ...manifestFor(claim),
      http: {
        ...manifestFor(claim).http,
        contentType: `${contentTypePrefix}${"x".repeat(MAX_HTTP_CONTENT_TYPE_LENGTH - contentTypePrefix.length)}`,
        etag: "e".repeat(MAX_HTTP_ETAG_LENGTH),
        lastModified: "m".repeat(MAX_HTTP_LAST_MODIFIED_LENGTH),
      },
      completeness: "c".repeat(MAX_COMPLETENESS_LENGTH),
    };
    expect(validateCaptureManifest(manifest)).toEqual(manifest);
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest });
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.manifest).toEqual(manifest);

    for (const [field, limit] of [["contentType", MAX_HTTP_CONTENT_TYPE_LENGTH], ["etag", MAX_HTTP_ETAG_LENGTH], ["lastModified", MAX_HTTP_LAST_MODIFIED_LENGTH]] as const) {
      const invalid = { ...manifest, http: { ...manifest.http, [field]: `${manifest.http[field]}x` } };
      expect(invalid.http[field]?.length).toBe(limit + 1);
      expect(() => validateCaptureManifest(invalid)).toThrow("contract");
      await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: invalid })).rejects.toThrow("bounded");
    }
    const tooLongCompleteness = { ...manifest, completeness: `${manifest.completeness}x` };
    expect(() => validateCaptureManifest(tooLongCompleteness)).toThrow("contract");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: tooLongCompleteness })).rejects.toThrow("bounded");
    const tooLongSource = { ...claim.request.source, relevance: `${claim.request.source.relevance}x` };
    expect(() => validateSourceMetadata(tooLongSource)).toThrow("collection contract");
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, relevance: tooLongSource.relevance, idempotencyKey: "too-long-relevance" })).rejects.toThrow("bounded");
  });

  test("both contracts preserve empty nullable headers and reject inconsistent complete-body lengths", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected header claim.");
    const manifest = { ...manifestFor(claim), http: { ...manifestFor(claim).http, etag: "", lastModified: "" } };
    expect(validateCaptureManifest(manifest)).toEqual(manifest);
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest });
    const wrongLength = { ...manifest, http: { ...manifest.http, contentLength: manifest.artifact.byteLength + 1 } };
    expect(() => validateCaptureManifest(wrongLength)).toThrow("contract");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: wrongLength })).rejects.toThrow("complete captured body");
  });

  test("only HTTP 200 can be checkpointed as a complete GET capture", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected complete-body claim.");
    const manifest = manifestFor(claim);
    expect(manifest.http.status).toBe(FULL_CAPTURE_HTTP_STATUS);
    expect(manifest.http.contentLength).toBe(manifest.artifact.byteLength);
    expect(validateCaptureManifest(manifest)).toEqual(manifest);
    for (const status of [201, 202, 204, 205, 206, 226, 299]) {
      const unexpected = { ...manifest, http: { ...manifest.http, status } };
      expect(() => validateCaptureManifest(unexpected)).toThrow("contract");
      await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: unexpected })).rejects.toThrow("requires HTTP 200");
    }
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.status).toBe("reserved");
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest });
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.status).toBe("staged");
  });

  test("both contracts reject blank or malformed metadata and empty series", async () => {
    const t = backend();
    for (const relevance of ["   ", "invalid\u0000text", "unpaired\ud800"]) {
      expect(() => validateSourceMetadata({ id: "fixture-source", url: SOURCE.url, title: SOURCE.title, relevance, series: SOURCE.series })).toThrow("collection contract");
      await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, relevance })).rejects.toThrow("bounded");
    }
    expect(() => validateSourceMetadata({ id: "fixture-source", url: SOURCE.url, title: SOURCE.title, relevance: SOURCE.relevance, series: [] })).toThrow("collection contract");
    await expect(t.mutation(internal.collection.submitSource, { ...SOURCE, series: [] })).rejects.toThrow("distinct");
  });

  test("a real source cannot inherit its approval when redirecting to a separately approved fixture", async () => {
    const t = backend();
    const realApproval = { ...APPROVAL, fixture: false, basis: "Maintainer-approved real-source test policy." };
    const fixtureApproval = { ...APPROVAL, origin: "https://fixture.example.com" };
    vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([realApproval, fixtureApproval]));
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected real source claim.");
    const finalUrl = "https://fixture.example.com/approved/source.txt";
    const manifest = { ...manifestFor(claim), finalUrl, redirects: [finalUrl], approval: realApproval, fixture: false };
    expect(() => validateCaptureManifest(manifest)).toThrow("contract");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest })).rejects.toThrow("complete maintainer approval");
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.status).toBe("reserved");
  });

  test("a claim is atomic and a revoked approval skips acquisition", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claims = await Promise.all([t.mutation(internal.collection.claimJob, { jobId }), t.mutation(internal.collection.claimJob, { jobId })]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const nextId = await acceptedJob(t, { url: "https://example.com/approved/other.txt", idempotencyKey: "second-job" });
    vi.stubEnv("COLLECTION_APPROVALS_JSON", undefined);
    expect(await t.mutation(internal.collection.claimJob, { jobId: nextId })).toBeNull();
    expect(await t.query(internal.collection.getStatus, { jobId: nextId })).toMatchObject({ job: { status: "skipped", error: { code: "SOURCE_NOT_APPROVED" } }, capture: null });
  });

  test("a staged capture survives failure and retry, preserving identity while rejecting stale workers", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const first = await t.mutation(internal.collection.claimJob, { jobId });
    if (!first) throw new Error("Expected first claim.");
    const manifest = manifestFor(first);
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: first.attempt, manifest });
    await t.mutation(internal.collection.recordFailed, { jobId, attempt: first.attempt, code: "PUBLICATION_UNAVAILABLE", message: "A safe worker failure" });
    await t.mutation(internal.collection.retryJob, { jobId });
    const second = await t.mutation(internal.collection.claimJob, { jobId });
    expect(second).toMatchObject({ request: first.request, attempt: first.attempt + 1, manifest });
    if (!second) throw new Error("Expected retry claim.");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: first.attempt, manifest })).rejects.toThrow("current running attempt");
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: second.attempt, manifest });
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: second.attempt, manifest: manifestFor(second, "b".repeat(64)) })).rejects.toThrow("different bytes or provenance");
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { phase: "staged", status: "running" }, capture: { manifest, stagingRetention: "retain" }, artifact: { sha256: manifest.artifact.sha256 }, processing: [] });
  });

  test("distinct captures of identical bytes share one artifact document", async () => {
    const t = backend();
    const firstId = await acceptedJob(t);
    const secondId = await acceptedJob(t, { url: "https://example.com/approved/equivalent.txt", idempotencyKey: "identical-content" });
    for (const jobId of [firstId, secondId]) {
      const claim = await t.mutation(internal.collection.claimJob, { jobId });
      if (!claim) throw new Error("Expected fixture claim.");
      await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: manifestFor(claim) });
    }
    const first = await t.query(internal.collection.getStatus, { jobId: firstId });
    const second = await t.query(internal.collection.getStatus, { jobId: secondId });
    expect(first?.capture?._id).not.toBe(second?.capture?._id);
    expect(first?.artifact?._id).toBe(second?.artifact?._id);
    const artifactCount = await t.run(async (ctx) => (await ctx.db.query("artifacts").withIndex("by_sha256", (q) => q.eq("sha256", "a".repeat(64))).take(2)).length);
    expect(artifactCount).toBe(1);
  });

  test("rejects invented provenance, redirects, raw paths and revoked stage approvals", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected claim.");
    const manifest = manifestFor(claim);
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: { ...manifest, source: { ...manifest.source, relevance: "Invented relevance" } } })).rejects.toThrow("source snapshot");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: { ...manifest, artifact: { ...manifest.artifact, path: "../../unexpected" } } })).rejects.toThrow("derived from its SHA-256");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: { ...manifest, finalUrl: "https://other.example.com/unapproved", redirects: ["https://other.example.com/unapproved"] } })).rejects.toThrow("maintainer approval");
    vi.stubEnv("COLLECTION_APPROVALS_JSON", undefined);
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest })).rejects.toThrow("current maintainer approval");
    expect((await t.query(internal.collection.getStatus, { jobId }))?.capture?.status).toBe("reserved");
  });

  test("the current byte limit and fixture label apply at both staging and publication", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected claim.");
    const manifest = manifestFor(claim);
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest: { ...manifest, fixture: false } })).rejects.toThrow("fixture label");
    vi.stubEnv("COLLECTION_MAX_BYTES", "47");
    await expect(t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest })).rejects.toThrow("bounds");
    vi.stubEnv("COLLECTION_MAX_BYTES", "48");
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest });
    vi.stubEnv("COLLECTION_MAX_BYTES", "47");
    await expect(t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication: publicationFor(manifest) })).rejects.toThrow("bounds");
    expect((await t.query(internal.collection.getStatus, { jobId }))?.job.status).toBe("running");
  });

  test("publication requires a staged capture, fixed target, generated paths and an immutable revision", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected claim.");
    const manifest = manifestFor(claim);
    const publication = publicationFor(manifest);
    await expect(t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication })).rejects.toThrow("staged capture");
    await t.mutation(internal.collection.recordStagedCapture, { jobId, attempt: claim.attempt, manifest });
    await expect(t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication: { ...publication, repo: "unrelated-repository" } })).rejects.toThrow("configured corpus");
    await expect(t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication: { ...publication, manifestPath: "captures/arbitrary.json" } })).rejects.toThrow("generated manifest path");
    await expect(t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication: { ...publication, manifestUrl: publication.manifestUrl.replace(publication.commitSha, "main") } })).rejects.toThrow("immutable commit");
    await t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication });
    await t.mutation(internal.collection.recordPublished, { jobId, attempt: claim.attempt, publication });
    expect(await t.query(internal.collection.getStatus, { jobId })).toMatchObject({ job: { status: "succeeded", phase: "published" }, capture: { status: "published", publication, stagingRetention: "retain" }, artifact: { sha256: manifest.artifact.sha256 }, processing: [] });
    await expect(t.mutation(internal.collection.retryJob, { jobId })).rejects.toThrow("Retry a failed job");
  });

  test("manual recovery respects the running safety window and invalidates prior checkpoints", async () => {
    const t = backend();
    const jobId = await acceptedJob(t);
    const first = await t.mutation(internal.collection.claimJob, { jobId });
    if (!first) throw new Error("Expected claim.");
    await expect(t.mutation(internal.collection.retryJob, { jobId })).rejects.toThrow("15-minute safety window");
    vi.setSystemTime(new Date(NOW.getTime() + 15 * 60 * 1000));
    await t.mutation(internal.collection.retryJob, { jobId });
    const next = await t.mutation(internal.collection.claimJob, { jobId });
    expect(next?.request.captureId).toBe(first.request.captureId);
    expect(next?.attempt).toBe(first.attempt + 1);
    await expect(t.mutation(internal.collection.recordFailed, { jobId, attempt: first.attempt, code: "COLLECTION_FAILED", message: "Late worker failure" })).rejects.toThrow("current running attempt");
  });

  test("configuration and failure records never return secret values or raw exception bodies", async () => {
    const t = backend();
    const marker = "secret-token-do-not-store";
    vi.stubEnv("S3_SECRET_ACCESS_KEY", marker);
    vi.stubEnv("CORPUS_GITHUB_TOKEN", marker);
    const configuration = await t.query(internal.collection.getConfiguration, {});
    expect(configuration.configuration).toContainEqual({ name: "S3_SECRET_ACCESS_KEY", configured: true });
    expect(JSON.stringify(configuration)).not.toContain(marker);
    const jobId = await acceptedJob(t);
    const claim = await t.mutation(internal.collection.claimJob, { jobId });
    if (!claim) throw new Error("Expected claim.");
    await t.mutation(internal.collection.recordFailed, { jobId, attempt: claim.attempt, code: "STAGING_UNAVAILABLE", message: `SDK error body: ${marker}` });
    const status = await t.query(internal.collection.getStatus, { jobId });
    expect(status?.job).toMatchObject({ status: "failed", phase: "acquiring", error: { code: "STAGING_UNAVAILABLE" } });
    expect(JSON.stringify(status)).not.toContain(marker);
  });
});
