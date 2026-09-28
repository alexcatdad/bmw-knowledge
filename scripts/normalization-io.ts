import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { manifestBytes, validateCaptureManifest, validateStoredCapture } from "@bmw-knowledge/collection";
import { normalizeCapture } from "@bmw-knowledge/normalization";
import {
  processingManifestBytes,
  processingManifestPathForCapture,
  processingManifestSchema,
  type ProcessingManifest,
} from "@bmw-knowledge/normalization/contract";

const execute = promisify(execFile);
const REVISION = /^[a-f0-9]{40}$/;
const CAPTURE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURE_COUNT = 100;
const FAILURE_CODES = new Set([
  "INVALID_CAPTURE", "INPUT_HASH_MISMATCH", "UNSUPPORTED_MEDIA_TYPE",
  "UNSUPPORTED_ENCODING", "OUTPUT_LIMIT", "IO_ERROR",
]);

export class NormalizationIoError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NormalizationIoError";
  }
}

export type NormalizationOutcome =
  | { status: "succeeded"; manifest: ProcessingManifest }
  | {
    status: "failed";
    captureId: string;
    inputSha256: string;
    processorRevision: string;
    code: string;
  };

export interface NormalizeCorpusOptions {
  corpusPath: string;
  processorRevision: string;
  inputCommitSha: string;
  captureIds?: string[];
}

function assertRevision(value: string): void {
  if (!REVISION.test(value)) throw new NormalizationIoError("INVALID_REVISION");
}

function assertCapture(value: string): void {
  if (!CAPTURE.test(value)) throw new NormalizationIoError("INVALID_CAPTURE_ID");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read tracked data at a revision, never a mutable or symlinked input file. */
async function readGitBytes(root: string, revision: string, file: string, maximum: number): Promise<Uint8Array> {
  assertRevision(revision);
  if (!/^(?:captures\/[A-Za-z0-9_-]{1,128}\.json|raw\/sha256\/[a-f0-9]{64}|processing\/[A-Za-z0-9_-]{1,128}\/[a-f0-9]{40}\.json|normalized\/[A-Za-z0-9_-]{1,128}\/[a-f0-9]{40}\/document\.(?:md|txt))$/.test(file)) {
    throw new NormalizationIoError("INVALID_CORPUS_PATH");
  }
  try {
    const tree = await execute("git", ["ls-tree", revision, "--", file], { cwd: root, maxBuffer: 2048 });
    if (!tree.stdout.startsWith("100644 blob ") || tree.stdout.trimEnd().split("\t")[1] !== file) {
      throw new NormalizationIoError("INVALID_CORPUS_FILE");
    }
    const result = await execute("git", ["show", `${revision}:${file}`], {
      cwd: root, encoding: "buffer", maxBuffer: maximum + 1,
    });
    if (result.stdout.length > maximum) throw new NormalizationIoError("INPUT_LIMIT");
    return new Uint8Array(result.stdout);
  } catch (error) {
    if (error instanceof NormalizationIoError) throw error;
    throw new NormalizationIoError("CORPUS_INPUT_UNAVAILABLE");
  }
}

async function safeParent(root: string, relative: string): Promise<string> {
  const pieces = relative.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) {
    throw new NormalizationIoError("INVALID_CORPUS_PATH");
  }
  let directory = root;
  for (const piece of pieces.slice(0, -1)) {
    directory = path.join(directory, piece);
    try { await mkdir(directory); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NormalizationIoError("UNSAFE_DERIVED_PATH");
  }
  return path.join(root, relative);
}

async function existingBytes(root: string, relative: string, maximum: number): Promise<Uint8Array | null> {
  const file = await safeParent(root, relative);
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
      throw new NormalizationIoError("UNSAFE_DERIVED_PATH");
    }
    return new Uint8Array(await readFile(file));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function createOrVerify(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  const file = await safeParent(root, relative);
  try { await writeFile(file, bytes, { flag: "wx" }); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const previous = await existingBytes(root, relative, bytes.byteLength);
    if (!previous || !equalBytes(previous, bytes)) throw new NormalizationIoError("DERIVED_FILE_CONFLICT");
  }
}

async function listCaptureIds(root: string, revision: string): Promise<string[]> {
  const result = await execute("git", ["ls-tree", "-r", "--name-only", revision, "--", "captures"], {
    cwd: root, maxBuffer: 64 * 1024,
  });
  const files = result.stdout.trim().split("\n").filter(Boolean);
  const ids: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const match = /^captures\/([A-Za-z0-9_-]{1,128})\.json$/.exec(file);
    if (!match?.[1]) throw new NormalizationIoError("INVALID_CORPUS_PATH");
    ids.push(match[1]);
  }
  if (ids.length > MAX_CAPTURE_COUNT) throw new NormalizationIoError("CAPTURE_BATCH_LIMIT");
  return ids.sort();
}

export async function normalizeCorpus(options: NormalizeCorpusOptions): Promise<NormalizationOutcome[]> {
  assertRevision(options.processorRevision);
  assertRevision(options.inputCommitSha);
  const root = await realpath(options.corpusPath);
  const repo = await execute("git", ["rev-parse", "--show-toplevel"], { cwd: root, maxBuffer: 4096 });
  if (await realpath(repo.stdout.trim()) !== root) throw new NormalizationIoError("CORPUS_ROOT_REQUIRED");
  const head = await execute("git", ["rev-parse", "HEAD"], { cwd: root, maxBuffer: 1024 });
  if (head.stdout.trim() !== options.inputCommitSha) throw new NormalizationIoError("INPUT_REVISION_MISMATCH");
  const ids = options.captureIds ?? await listCaptureIds(root, options.inputCommitSha);
  if (ids.length > MAX_CAPTURE_COUNT || new Set(ids).size !== ids.length) throw new NormalizationIoError("CAPTURE_BATCH_LIMIT");
  ids.forEach(assertCapture);
  const outcomes: NormalizationOutcome[] = [];
  for (const captureId of ids) {
    const originalManifest = await readGitBytes(root, options.inputCommitSha, `captures/${captureId}.json`, 64 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(originalManifest)); } catch {
      throw new NormalizationIoError("INVALID_CAPTURE_MANIFEST");
    }
    if (!parsed || typeof parsed !== "object" || !("artifact" in parsed) || !parsed.artifact || typeof parsed.artifact !== "object" || !("sha256" in parsed.artifact) || typeof parsed.artifact.sha256 !== "string" || !HASH.test(parsed.artifact.sha256)) {
      throw new NormalizationIoError("INVALID_CAPTURE_MANIFEST");
    }
    const declaredManifest = validateCaptureManifest(parsed);
    if (declaredManifest.captureId !== captureId || !equalBytes(originalManifest, manifestBytes(declaredManifest))) {
      throw new NormalizationIoError("NONCANONICAL_CAPTURE_MANIFEST");
    }
    try {
      const input = await readGitBytes(root, options.inputCommitSha, declaredManifest.artifact.path, MAX_INPUT_BYTES);
      const capture = validateStoredCapture({ manifest: declaredManifest, bytes: input });
      const receiptPath = processingManifestPathForCapture(captureId, options.processorRevision);
      const existingReceipt = await existingBytes(root, receiptPath, 64 * 1024);
      let inputCommitSha = options.inputCommitSha;
      if (existingReceipt) {
        const receipt = processingManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existingReceipt)));
        if (receipt.captureId !== captureId || receipt.processor.revision !== options.processorRevision || receipt.input.sha256 !== hash(input)) {
          throw new NormalizationIoError("DERIVED_FILE_CONFLICT");
        }
        inputCommitSha = receipt.input.commitSha;
        const [oldManifest, oldInput] = await Promise.all([
          readGitBytes(root, inputCommitSha, `captures/${captureId}.json`, 64 * 1024),
          readGitBytes(root, inputCommitSha, capture.manifest.artifact.path, MAX_INPUT_BYTES),
        ]);
        if (!equalBytes(oldManifest, originalManifest) || !equalBytes(oldInput, input)) {
          throw new NormalizationIoError("DERIVED_FILE_CONFLICT");
        }
      }
      const normalized = normalizeCapture({ manifest: capture.manifest, bytes: input, processorRevision: options.processorRevision, inputCommitSha });
      const receiptBytes = processingManifestBytes(normalized.manifest);
      if (existingReceipt && !equalBytes(existingReceipt, receiptBytes)) throw new NormalizationIoError("DERIVED_FILE_CONFLICT");
      await createOrVerify(root, normalized.manifest.output.path, normalized.bytes);
      await createOrVerify(root, receiptPath, receiptBytes);
      outcomes.push({ status: "succeeded", manifest: normalized.manifest });
    } catch (error) {
      const candidate = error && typeof error === "object" && "code" in error ? error.code : null;
      const code = candidate === "CAPTURE_INTEGRITY_FAILED" ? "INPUT_HASH_MISMATCH" : typeof candidate === "string" && FAILURE_CODES.has(candidate) ? candidate : "IO_ERROR";
      outcomes.push({ status: "failed", captureId, inputSha256: declaredManifest.artifact.sha256, processorRevision: options.processorRevision, code });
    }
  }
  return outcomes;
}

/** Report only files proved to exist in the exact result commit. */
export async function reportNormalization(options: {
  corpusPath: string;
  resultCommitSha: string;
  outcomes: NormalizationOutcome[];
  callbackUrl: string;
  secret: string;
  owner: string;
  repo: string;
  fetch?: typeof globalThis.fetch;
}): Promise<number> {
  assertRevision(options.resultCommitSha);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(options.owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(options.repo) || [".", ".."].includes(options.repo)) throw new NormalizationIoError("INVALID_CORPUS_TARGET");
  const callback = new URL(options.callbackUrl);
  if (callback.protocol !== "https:" || !callback.hostname.endsWith(".convex.site") || callback.port || callback.username || callback.password || callback.pathname !== "/processing/result" || callback.search || callback.hash || !/^[A-Za-z0-9_-]{32,256}$/.test(options.secret)) {
    throw new NormalizationIoError("INVALID_CALLBACK_CONFIGURATION");
  }
  if (options.outcomes.length > MAX_CAPTURE_COUNT) throw new NormalizationIoError("CAPTURE_BATCH_LIMIT");
  const root = await realpath(options.corpusPath);
  for (const outcome of options.outcomes) {
    if (outcome.status === "succeeded") {
      const manifest = processingManifestSchema.parse(outcome.manifest);
      const receipt = await readGitBytes(root, options.resultCommitSha, processingManifestPathForCapture(manifest.captureId, manifest.processor.revision), 64 * 1024);
      const output = await readGitBytes(root, options.resultCommitSha, manifest.output.path, manifest.output.byteLength);
      if (!equalBytes(receipt, processingManifestBytes(manifest)) || hash(output) !== manifest.output.sha256 || output.byteLength !== manifest.output.byteLength) {
        throw new NormalizationIoError("RESULT_COMMIT_MISMATCH");
      }
    } else {
      assertCapture(outcome.captureId);
      assertRevision(outcome.processorRevision);
      if (!HASH.test(outcome.inputSha256) || !FAILURE_CODES.has(outcome.code)) throw new NormalizationIoError("INVALID_PROCESSING_FAILURE");
    }
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  for (const outcome of options.outcomes) {
    const body = outcome.status === "succeeded"
      ? { ...outcome, publication: { owner: options.owner, repo: options.repo, commitSha: options.resultCommitSha } }
      : outcome;
    try {
      const response = await fetcher(callback.href, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.secret}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new NormalizationIoError("PROCESSING_CALLBACK_FAILED");
      await response.body?.cancel();
    } catch { throw new NormalizationIoError("PROCESSING_CALLBACK_FAILED"); }
  }
  return options.outcomes.length;
}
