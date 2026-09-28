// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  canonicalCaptureManifestText,
  MAX_PROCESSING_MANIFEST_BYTES,
  normalizedPathForCapture,
  processingManifestPathForCapture,
  processingManifestText,
  PROCESSOR_NAME,
  PROCESSOR_VERSION,
  type ProcessingManifest,
} from "@bmw-knowledge/normalization/contract";
import type { Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { sha256, utf8 } from "./digests";
import schema from "./schema";
import { captureManifestValidator } from "./validators";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "a".repeat(64);
const PROCESSOR_REVISION = "b".repeat(40);
const INPUT_COMMIT = "2".repeat(40);
const PUBLICATION = { owner: "alexcatdad", repo: "bmw-corpus", commitSha: "3".repeat(40) };
const NOW = new Date("2026-09-28T12:00:00.000Z");
const APPROVAL = { origin: "https://example.com", pathPrefix: "/approved", approvedBy: "Test maintainer", basis: "Synthetic fixture owned by its author; plumbing test only.", approvedAt: "2026-09-28T11:00:00.000Z", fixture: true };

function backend() { return convexTest(schema, modules); }

async function seededCapture(t: ReturnType<typeof backend>, name = "one", published = true) {
  const raw = utf8("<p>Synthetic E30 wiring fixture.</p>\n");
  const hash = await sha256(raw);
  const submitted = await t.mutation(internal.collection.submitSource, { url: `https://example.com/approved/${name}.html`, relevance: `Test source context ${name}`, series: ["E30"], idempotencyKey: `processing-${name}` });
  if (!submitted.jobId) throw new Error("Expected approved fixture job.");
  const claim = await t.mutation(internal.collection.claimJob, { jobId: submitted.jobId });
  if (!claim) throw new Error("Expected fixture claim.");
  const manifest: Infer<typeof captureManifestValidator> = {
    schemaVersion: 1, kind: "http_response_capture", source: claim.request.source, jobId: claim.request.jobId, captureId: claim.request.captureId,
    requestedUrl: claim.request.source.url, finalUrl: claim.request.source.url, retrievedAt: NOW.toISOString(),
    http: { status: 200, contentType: "text/html; charset=utf-8", contentLength: raw.byteLength, etag: null, lastModified: null },
    redirects: [], artifact: { sha256: hash, byteLength: raw.byteLength, mediaType: "text/html", path: `raw/sha256/${hash}` },
    approval: APPROVAL, fixture: true, completeness: "Complete HTTP response body; linked pages and attachments were not acquired.",
  };
  await t.mutation(internal.collection.recordStagedCapture, { jobId: submitted.jobId, attempt: claim.attempt, manifest });
  if (published) {
    const prefix = `https://github.com/alexcatdad/bmw-corpus/blob/${"1".repeat(40)}/`;
    await t.mutation(internal.collection.recordPublished, { jobId: submitted.jobId, attempt: claim.attempt, publication: { owner: "alexcatdad", repo: "bmw-corpus", branch: "main", commitSha: "1".repeat(40), artifactPath: manifest.artifact.path, manifestPath: `captures/${manifest.captureId}.json`, artifactUrl: `${prefix}${manifest.artifact.path}`, manifestUrl: `${prefix}captures/${manifest.captureId}.json` } });
  }
  return { jobId: submitted.jobId, captureId: claim.request.captureId as Id<"captures">, manifest, raw };
}

async function processingFor(capture: Awaited<ReturnType<typeof seededCapture>>, revision = PROCESSOR_REVISION, outputText = "Synthetic E30 wiring fixture.\n") {
  const bytes = utf8(outputText);
  const manifest: ProcessingManifest = {
    schemaVersion: 1, kind: "normalization_result", captureId: capture.captureId,
    input: { artifactPath: capture.manifest.artifact.path, sha256: capture.manifest.artifact.sha256, byteLength: capture.raw.byteLength, manifestSha256: await sha256(utf8(canonicalCaptureManifestText(capture.manifest))), commitSha: INPUT_COMMIT },
    processor: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION, revision },
    output: { path: normalizedPathForCapture(capture.captureId, revision, "text/markdown"), sha256: await sha256(bytes), byteLength: bytes.byteLength, mediaType: "text/markdown" },
    fixture: true, warnings: ["layout-not-preserved", "linked-resources-not-acquired"],
  };
  return { manifest, bytes };
}

async function proofFor(manifest: ProcessingManifest) {
  return { inputSha256: manifest.input.sha256, inputByteLength: manifest.input.byteLength, inputManifestSha256: manifest.input.manifestSha256, outputSha256: manifest.output.sha256, outputByteLength: manifest.output.byteLength, receiptSha256: await sha256(utf8(processingManifestText(manifest))) };
}

function rawUrl(commit: string, path: string) { return `https://raw.githubusercontent.com/alexcatdad/bmw-corpus/${commit}/${path}`; }

function filesFor(capture: Awaited<ReturnType<typeof seededCapture>>, normalized: Awaited<ReturnType<typeof processingFor>>, publication = PUBLICATION) {
  return new Map<string, Uint8Array>([
    [rawUrl(normalized.manifest.input.commitSha, `captures/${capture.captureId}.json`), utf8(canonicalCaptureManifestText(capture.manifest))],
    [rawUrl(normalized.manifest.input.commitSha, capture.manifest.artifact.path), capture.raw],
    [rawUrl(publication.commitSha, processingManifestPathForCapture(capture.captureId, normalized.manifest.processor.revision)), utf8(processingManifestText(normalized.manifest))],
    [rawUrl(publication.commitSha, normalized.manifest.output.path), normalized.bytes],
  ]);
}

function mockCorpus(files: Map<string, Uint8Array>) {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const bytes = files.get(url);
    return bytes ? new Response(bytes.slice(), { status: 200 }) : new Response("Not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function callback(t: ReturnType<typeof backend>, body: unknown, secret = SECRET) {
  return await t.fetch("/processing/result", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubEnv("COLLECTION_APPROVALS_JSON", JSON.stringify([APPROVAL]));
  vi.stubEnv("PROCESSING_CALLBACK_SECRET", SECRET);
  for (const name of ["COLLECTION_MAX_BYTES", "COLLECTION_TIMEOUT_MS", "CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH"]) vi.stubEnv(name, undefined);
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("normalization state", () => {
  test("keeps failure history through successful retry and ignores late failure downgrades", async () => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    const failure = { captureId: capture.captureId, inputSha256: normalized.manifest.input.sha256, processorRevision: PROCESSOR_REVISION, code: "IO_ERROR" as const };
    expect(await t.mutation(internal.processing.recordFailure, failure)).toMatchObject({ status: "failed", duplicate: false });
    expect(await t.mutation(internal.processing.recordFailure, failure)).toMatchObject({ status: "failed", duplicate: true });
    await t.mutation(internal.processing.recordSuccess, { manifest: normalized.manifest, publication: PUBLICATION, proof: await proofFor(normalized.manifest) });
    expect(await t.mutation(internal.processing.recordFailure, { ...failure, code: "UNSUPPORTED_ENCODING" })).toMatchObject({ status: "succeeded", ignored: true });
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result).toMatchObject({ status: "succeeded", publication: PUBLICATION });
    expect(result?.history).toHaveLength(3);
    expect(result?.history).toContainEqual(expect.objectContaining({ status: "failed", code: "IO_ERROR" }));
    expect(result?.history).toContainEqual(expect.objectContaining({ status: "failed", code: "UNSUPPORTED_ENCODING", ignored: true }));
    const status = await t.query(internal.collection.getStatus, { jobId: capture.jobId });
    expect(status).toMatchObject({ job: { status: "succeeded" }, capture: { stagingRetention: "retain" }, processing: [expect.objectContaining({ status: "succeeded" })] });
    const bounded = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION, historyLimit: 1 });
    expect(bounded?.history).toHaveLength(1);
    expect(bounded?.historyTruncated).toBe(true);
    await expect(t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION, historyLimit: 101 })).rejects.toThrow("one hundred");
  });

  test("exact success replay at a newer corpus commit retains the first publication; changed results conflict", async () => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    const success = { manifest: normalized.manifest, publication: PUBLICATION, proof: await proofFor(normalized.manifest) };
    expect(await t.mutation(internal.processing.recordSuccess, success)).toMatchObject({ replayed: false });
    expect(await t.mutation(internal.processing.recordSuccess, { ...success, publication: { ...PUBLICATION, commitSha: "4".repeat(40) } })).toMatchObject({ replayed: true });
    const changed = await processingFor(capture, PROCESSOR_REVISION, "Different output.\n");
    await expect(t.mutation(internal.processing.recordSuccess, { manifest: changed.manifest, publication: PUBLICATION, proof: await proofFor(changed.manifest) })).rejects.toThrow("different verified result");
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result.publication).toEqual(PUBLICATION);
    expect(result?.history).toHaveLength(1);
  });

  test("shared raw content produces separate processing records and paths for separate capture contexts", async () => {
    const t = backend();
    const first = await seededCapture(t, "first");
    const second = await seededCapture(t, "second");
    const a = await processingFor(first);
    const b = await processingFor(second);
    expect(a.manifest.input.sha256).toBe(b.manifest.input.sha256);
    expect(a.manifest.input.manifestSha256).not.toBe(b.manifest.input.manifestSha256);
    expect(a.manifest.output.path).not.toBe(b.manifest.output.path);
    for (const manifest of [a.manifest, b.manifest]) await t.mutation(internal.processing.recordSuccess, { manifest, publication: PUBLICATION, proof: await proofFor(manifest) });
    expect((await t.query(internal.collection.getStatus, { jobId: first.jobId }))?.processing).toHaveLength(1);
    expect((await t.query(internal.collection.getStatus, { jobId: second.jobId }))?.processing).toHaveLength(1);
  });

  test("internal checkpoints reject unpublished, mismatched input, fixture and proof claims", async () => {
    const t = backend();
    const unpublished = await seededCapture(t, "unpublished", false);
    const candidate = await processingFor(unpublished);
    await expect(t.mutation(internal.processing.recordSuccess, { manifest: candidate.manifest, publication: PUBLICATION, proof: await proofFor(candidate.manifest) })).rejects.toThrow("published capture");
    await expect(t.mutation(internal.processing.recordFailure, { captureId: unpublished.captureId, inputSha256: candidate.manifest.input.sha256, processorRevision: PROCESSOR_REVISION, code: "IO_ERROR" })).rejects.toThrow("published capture");
    const capture = await seededCapture(t, "published");
    const normalized = await processingFor(capture);
    await expect(t.mutation(internal.processing.recordSuccess, { manifest: { ...normalized.manifest, fixture: false }, publication: PUBLICATION, proof: await proofFor(normalized.manifest) })).rejects.toThrow("fixture label");
    await expect(t.mutation(internal.processing.recordFailure, { captureId: capture.captureId, inputSha256: "f".repeat(64), processorRevision: PROCESSOR_REVISION, code: "IO_ERROR" })).rejects.toThrow("input hash");
    await expect(t.mutation(internal.processing.recordSuccess, { manifest: normalized.manifest, publication: PUBLICATION, proof: { ...await proofFor(normalized.manifest), outputSha256: "f".repeat(64) } })).rejects.toThrow("verified file hashes");
    expect(await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION })).toBeNull();
  });
});

describe("authenticated processing callback", () => {
  test("is disabled without a strong configured secret and rejects missing, short or wrong bearer tokens", async () => {
    const t = backend();
    const network = mockCorpus(new Map());
    vi.stubEnv("PROCESSING_CALLBACK_SECRET", undefined);
    expect((await callback(t, {})).status).toBe(401);
    vi.stubEnv("PROCESSING_CALLBACK_SECRET", "x".repeat(31));
    expect((await callback(t, {}, "x".repeat(31))).status).toBe(401);
    vi.stubEnv("PROCESSING_CALLBACK_SECRET", SECRET);
    expect((await t.fetch("/processing/result", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await callback(t, {}, `${SECRET.slice(0, -1)}z`)).status).toBe(401);
    expect((await callback(t, {}, `${SECRET}extra`)).status).toBe(401);
    expect(network).not.toHaveBeenCalled();
  });

  test("rejects malformed, oversized streamed, unknown-field and wrong-target bodies before any external proof", async () => {
    const t = backend();
    const network = mockCorpus(new Map());
    const malformed = await t.fetch("/processing/result", { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_PROCESSING_MANIFEST_BYTES + 1)); controller.close(); } });
    const streamRequest: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: stream, duplex: "half" };
    expect((await t.fetch("/processing/result", streamRequest)).status).toBe(413);
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    expect((await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: { ...PUBLICATION, repo: "unrelated" } })).status).toBe(400);
    expect((await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION, grantAcquisition: true })).status).toBe(400);
    expect((await callback(t, { status: "succeeded", manifest: { ...normalized.manifest, output: { ...normalized.manifest.output, path: "../../private" } }, publication: PUBLICATION })).status).toBe(400);
    expect((await callback(t, { status: "failed", captureId: capture.captureId, inputSha256: normalized.manifest.input.sha256, processorRevision: PROCESSOR_REVISION, code: "ARBITRARY_PRIVATE_ERROR_TEXT" })).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });

  test("proves four files at their exact immutable revisions, then records an idempotent success", async () => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    const network = mockCorpus(filesFor(capture, normalized));
    const body = { status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION };
    const responses = await Promise.all([callback(t, body), callback(t, body)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(network).toHaveBeenCalledTimes(8);
    expect(network.mock.calls.map(([url]) => url)).toContain(rawUrl(INPUT_COMMIT, capture.manifest.artifact.path));
    expect(INPUT_COMMIT).not.toBe("1".repeat(40));
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result).toMatchObject({ status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION });
    expect(result?.history).toHaveLength(1);
  });

  test("a newer verified publication of the same receipt preserves the first output locator", async () => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    mockCorpus(filesFor(capture, normalized));
    expect((await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION })).status).toBe(200);
    const later = { ...PUBLICATION, commitSha: "4".repeat(40) };
    mockCorpus(filesFor(capture, normalized, later));
    const replay = await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: later });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result.publication).toEqual(PUBLICATION);
    expect(result?.result.manifest?.input.commitSha).toBe(INPUT_COMMIT);
  });

  test("unpublished and mismatched fixture claims cannot trigger corpus requests", async () => {
    const t = backend();
    const unpublished = await seededCapture(t, "unpublished", false);
    const candidate = await processingFor(unpublished);
    const network = mockCorpus(new Map());
    expect((await callback(t, { status: "succeeded", manifest: candidate.manifest, publication: PUBLICATION })).status).toBe(409);
    const capture = await seededCapture(t, "published");
    const normalized = await processingFor(capture);
    expect((await callback(t, { status: "succeeded", manifest: { ...normalized.manifest, fixture: false }, publication: PUBLICATION })).status).toBe(409);
    expect(network).not.toHaveBeenCalled();
    expect(await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION })).toBeNull();
  });

  test.each(["input", "capture", "receipt", "output", "commit"] as const)("a wrong %s proof cannot mark processing successful", async (part) => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    const files = filesFor(capture, normalized);
    const url = part === "input" ? rawUrl(INPUT_COMMIT, capture.manifest.artifact.path)
      : part === "capture" ? rawUrl(INPUT_COMMIT, `captures/${capture.captureId}.json`)
      : part === "receipt" ? rawUrl(PUBLICATION.commitSha, processingManifestPathForCapture(capture.captureId, PROCESSOR_REVISION))
      : rawUrl(PUBLICATION.commitSha, normalized.manifest.output.path);
    if (part !== "commit") {
      const original = files.get(url);
      if (!original) throw new Error("Missing proof fixture.");
      const changed = original.slice();
      changed[0] = (changed[0] ?? 0) ^ 1;
      files.set(url, changed);
    }
    mockCorpus(files);
    const response = await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: part === "commit" ? { ...PUBLICATION, commitSha: "f".repeat(40) } : PUBLICATION });
    expect(response.status).toBe(502);
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result.status).toBe("failed");
    expect(result?.result.manifest).toBeUndefined();
    expect((await t.query(internal.collection.getStatus, { jobId: capture.jobId }))?.job.status).toBe("succeeded");
  });

  test("failure callbacks preserve safe history and fetch errors never leak secrets or upstream bodies", async () => {
    const t = backend();
    const capture = await seededCapture(t);
    const normalized = await processingFor(capture);
    const privateText = "private-upstream-token-do-not-store";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(privateText); }));
    const rejected = await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION });
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).not.toContain(privateText);
    const result = await t.query(internal.processing.getResult, { captureId: capture.captureId, processorRevision: PROCESSOR_REVISION });
    expect(result?.result).toMatchObject({ status: "failed", error: { code: "IO_ERROR" } });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    mockCorpus(filesFor(capture, normalized));
    expect((await callback(t, { status: "succeeded", manifest: normalized.manifest, publication: PUBLICATION })).status).toBe(200);
    const late = await callback(t, { status: "failed", captureId: capture.captureId, inputSha256: normalized.manifest.input.sha256, processorRevision: PROCESSOR_REVISION, code: "UNSUPPORTED_ENCODING" });
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ status: "succeeded", ignored: true });
  });
});
