import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { manifestBytes, type StoredCapture } from "@bmw-knowledge/collection";
import { captureFixture } from "../packages/collection/test/helpers.js";
import { normalizeCorpus, reportNormalization, type NormalizationOutcome } from "./normalization-io.js";

const execute = promisify(execFile);
const processorRevision = "a".repeat(40);
const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });

async function writeCapture(root: string, capture: StoredCapture): Promise<void> {
  await mkdir(path.join(root, "captures"), { recursive: true });
  await mkdir(path.join(root, "raw/sha256"), { recursive: true });
  await writeFile(path.join(root, `captures/${capture.manifest.captureId}.json`), manifestBytes(capture.manifest));
  await writeFile(path.join(root, capture.manifest.artifact.path), capture.bytes);
}

async function commit(root: string): Promise<string> {
  await execute("git", ["add", "--all"], { cwd: root });
  await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Project-owned fixture"], { cwd: root });
  return (await execute("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

async function setup(capture = captureFixture("<h1>Project fixture</h1><p><a href='./manual'>Fixture link</a></p>")) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bmw-normalization-test-"));
  temporary.push(root);
  await execute("git", ["init", "-q"], { cwd: root });
  await writeCapture(root, capture);
  const inputCommitSha = await commit(root);
  return { root, capture, inputCommitSha, options: { corpusPath: root, processorRevision, inputCommitSha } };
}

function success(outcomes: NormalizationOutcome[]) {
  const item = outcomes[0];
  if (!item || item.status !== "succeeded") throw new Error("Fixture normalization unexpectedly failed.");
  return item;
}

test("normalization preserves captured bytes and is an exact create-only replay", async () => {
  const fixture = await setup();
  const first = success(await normalizeCorpus(fixture.options));
  expect(first.manifest.fixture).toBe(true);
  expect(await readFile(path.join(fixture.root, first.manifest.output.path), "utf8")).toContain("https://example.com/approved/manual");
  const repeated = success(await normalizeCorpus(fixture.options));
  expect(repeated).toEqual(first);
  expect(new Uint8Array(await readFile(path.join(fixture.root, fixture.capture.manifest.artifact.path)))).toEqual(fixture.capture.bytes);
  expect(new Uint8Array(await readFile(path.join(fixture.root, "captures/capture-1.json")))).toEqual(manifestBytes(fixture.capture.manifest));
});

test("new corpus commits reuse the original receipt input revision", async () => {
  const fixture = await setup();
  const first = success(await normalizeCorpus(fixture.options));
  await commit(fixture.root);
  await writeCapture(fixture.root, captureFixture("<p>Another owned fixture</p>", "capture-2"));
  const newer = await commit(fixture.root);
  const outcomes = await normalizeCorpus({ ...fixture.options, inputCommitSha: newer });
  expect(success(outcomes)).toEqual(first);
  expect(outcomes).toHaveLength(2);
  const second = outcomes[1];
  if (second?.status !== "succeeded") throw new Error("Second fixture failed.");
  expect(second.manifest.input.commitSha).toBe(newer);
});

test("mutable source files cannot change the declared immutable input", async () => {
  const fixture = await setup();
  await writeFile(path.join(fixture.root, fixture.capture.manifest.artifact.path), "modified working file");
  const output = success(await normalizeCorpus(fixture.options));
  expect(await readFile(path.join(fixture.root, output.manifest.output.path), "utf8")).toContain("Project fixture");
  expect(await readFile(path.join(fixture.root, fixture.capture.manifest.artifact.path), "utf8")).toBe("modified working file");
});

test("an input revision that is not the checked out corpus HEAD is rejected", async () => {
  const fixture = await setup();
  await writeFile(path.join(fixture.root, "README.md"), "fixture");
  await commit(fixture.root);
  await expect(normalizeCorpus(fixture.options)).rejects.toMatchObject({ code: "INPUT_REVISION_MISMATCH" });
});

test("conflicting derived bytes are kept and reported as a failure", async () => {
  const fixture = await setup();
  const output = success(await normalizeCorpus(fixture.options));
  await writeFile(path.join(fixture.root, output.manifest.output.path), "conflicting output");
  expect(await normalizeCorpus(fixture.options)).toMatchObject([{ status: "failed", code: "IO_ERROR" }]);
  expect(await readFile(path.join(fixture.root, output.manifest.output.path), "utf8")).toBe("conflicting output");
});

test("derived directory symlinks cannot redirect output outside the corpus", async () => {
  const fixture = await setup();
  const outside = await mkdtemp(path.join(os.tmpdir(), "bmw-normalization-outside-"));
  temporary.push(outside);
  await symlink(outside, path.join(fixture.root, "processing"));
  expect(await normalizeCorpus(fixture.options)).toMatchObject([{ status: "failed", code: "IO_ERROR" }]);
  await expect(readFile(path.join(outside, "capture-1", `${processorRevision}.json`))).rejects.toMatchObject({ code: "ENOENT" });
});

test("symlink-mode input artifacts are rejected even when their blob hashes match", async () => {
  const fixture = await setup(captureFixture("target-file"));
  await rm(path.join(fixture.root, fixture.capture.manifest.artifact.path));
  await symlink("target-file", path.join(fixture.root, fixture.capture.manifest.artifact.path));
  const revision = await commit(fixture.root);
  expect(await normalizeCorpus({ ...fixture.options, inputCommitSha: revision })).toMatchObject([{ status: "failed", code: "IO_ERROR" }]);
});

test("noncanonical published manifests are rejected rather than assigned a different hash", async () => {
  const fixture = await setup();
  await writeFile(path.join(fixture.root, "captures/capture-1.json"), JSON.stringify(fixture.capture.manifest));
  const revision = await commit(fixture.root);
  await expect(normalizeCorpus({ ...fixture.options, inputCommitSha: revision })).rejects.toMatchObject({ code: "NONCANONICAL_CAPTURE_MANIFEST" });
});

test("capture identifiers cannot choose an arbitrary filesystem path", async () => {
  const fixture = await setup();
  await expect(normalizeCorpus({ ...fixture.options, captureIds: ["../../outside"] })).rejects.toMatchObject({ code: "INVALID_CAPTURE_ID" });
  await expect(normalizeCorpus({ ...fixture.options, captureIds: ["capture-1", "capture-1"] })).rejects.toMatchObject({ code: "CAPTURE_BATCH_LIMIT" });
});

test("unsupported encoding creates a narrow failure result without derived content", async () => {
  const capture = captureFixture("<p>Owned fixture</p>");
  capture.manifest.http.contentType = "text/html; charset=iso-8859-1";
  const fixture = await setup(capture);
  expect(await normalizeCorpus(fixture.options)).toMatchObject([{ status: "failed", code: "UNSUPPORTED_ENCODING", inputSha256: capture.manifest.artifact.sha256 }]);
});

test("broken published raw bytes produce an inspectable input-hash failure", async () => {
  const fixture = await setup();
  await writeFile(path.join(fixture.root, fixture.capture.manifest.artifact.path), "broken corpus bytes");
  const revision = await commit(fixture.root);
  expect(await normalizeCorpus({ ...fixture.options, inputCommitSha: revision })).toMatchObject([{ status: "failed", code: "INPUT_HASH_MISMATCH", inputSha256: fixture.capture.manifest.artifact.sha256 }]);
});

test("reporting requires receipt and output in the exact result commit", async () => {
  const fixture = await setup();
  const outcomes = await normalizeCorpus(fixture.options);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
  const options = { corpusPath: fixture.root, resultCommitSha: fixture.inputCommitSha, outcomes, callbackUrl: "https://fixture.convex.site/processing/result", secret: "x".repeat(48), owner: "alexcatdad", repo: "bmw-corpus", fetch: fetcher };
  await expect(reportNormalization(options)).rejects.toMatchObject({ code: "INVALID_CORPUS_FILE" });
  expect(fetcher).not.toHaveBeenCalled();
  const resultCommitSha = await commit(fixture.root);
  expect(await reportNormalization({ ...options, resultCommitSha })).toBe(1);
  const request = fetcher.mock.calls[0]?.[1];
  expect(request?.redirect).toBe("error");
  expect(JSON.parse(String(request?.body))).toMatchObject({ status: "succeeded", publication: { commitSha: resultCommitSha } });
});

test("callback failures do not expose upstream messages or credentials", async () => {
  const fixture = await setup();
  const outcomes = await normalizeCorpus(fixture.options);
  const resultCommitSha = await commit(fixture.root);
  const secret = "secret".repeat(8);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`upstream ${secret}`, { status: 500 }));
  await expect(reportNormalization({ corpusPath: fixture.root, resultCommitSha, outcomes, callbackUrl: "https://fixture.convex.site/processing/result", secret, owner: "alexcatdad", repo: "bmw-corpus", fetch: fetcher })).rejects.toThrow(/^PROCESSING_CALLBACK_FAILED$/);
});

test("invalid callback URLs and failure codes are rejected before authentication is sent", async () => {
  const fixture = await setup();
  const fetcher = vi.fn<typeof fetch>();
  const options = { corpusPath: fixture.root, resultCommitSha: fixture.inputCommitSha, outcomes: [] as NormalizationOutcome[], callbackUrl: "https://fixture.convex.site/processing/result", secret: "x".repeat(48), owner: "alexcatdad", repo: "bmw-corpus", fetch: fetcher };
  await expect(reportNormalization({ ...options, callbackUrl: "https://example.com/processing/result" })).rejects.toMatchObject({ code: "INVALID_CALLBACK_CONFIGURATION" });
  await expect(reportNormalization({ ...options, outcomes: [{ status: "failed", captureId: "capture-1", inputSha256: fixture.capture.manifest.artifact.sha256, processorRevision, code: "upstream-secret" }] })).rejects.toMatchObject({ code: "INVALID_PROCESSING_FAILURE" });
  expect(fetcher).not.toHaveBeenCalled();
});
