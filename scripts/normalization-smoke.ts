import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { manifestBytes, sha256Bytes } from "@bmw-knowledge/collection";
import { processingManifestPathForCapture, processingManifestSchema } from "@bmw-knowledge/normalization/contract";
import { captureFixture } from "../packages/collection/test/helpers.js";

const execute = promisify(execFile);
const toolingRoot = fileURLToPath(new URL("../", import.meta.url));
const corpus = await mkdtemp(path.join(os.tmpdir(), "bmw-normalization-smoke-"));
try {
  const source = await readFile(path.join(toolingRoot, "fixtures/http-source.html"));
  const capture = captureFixture(source.toString("utf8"), "synthetic-normalization-fixture");
  capture.manifest.completeness = "Synthetic project-owned fixture for processor integration; no live HTTP acquisition.";
  await mkdir(path.join(corpus, "captures"));
  await mkdir(path.join(corpus, "raw/sha256"), { recursive: true });
  await writeFile(path.join(corpus, "captures/synthetic-normalization-fixture.json"), manifestBytes(capture.manifest));
  await writeFile(path.join(corpus, capture.manifest.artifact.path), source);
  await execute("git", ["init", "--initial-branch=main", "-q"], { cwd: corpus });
  await execute("git", ["add", "--all"], { cwd: corpus });
  await execute("git", ["-c", "user.name=Normalization fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Synthetic fixture only"], { cwd: corpus });
  const inputRevision = (await execute("git", ["rev-parse", "HEAD"], { cwd: corpus })).stdout.trim();
  const processorRevision = (await execute("git", ["rev-parse", "HEAD"], { cwd: toolingRoot })).stdout.trim();
  const command = ["exec", "tsx", "scripts/normalize.ts", "--corpus", corpus, "--all", "--processor-revision", processorRevision, "--input-revision", inputRevision];
  const first = await execute("pnpm", command, { cwd: toolingRoot, maxBuffer: 1024 * 1024 });
  const second = await execute("pnpm", command, { cwd: toolingRoot, maxBuffer: 1024 * 1024 });
  assert.equal(second.stdout, first.stdout);
  const receiptPath = processingManifestPathForCapture(capture.manifest.captureId, processorRevision);
  const receipt = processingManifestSchema.parse(JSON.parse(await readFile(path.join(corpus, receiptPath), "utf8")));
  const normalized = await readFile(path.join(corpus, receipt.output.path));
  const expected = "# Collection integration fixture\n\nThis project-owned page tests HTTP capture, provenance, and publication.\n\nIt contains no automotive facts and must not be counted as BMW evidence.\n\nThe current research scope names E30 and E46.\n\n[Software repository](https://github.com/alexcatdad/bmw-knowledge)\n\n[Corpus repository](https://github.com/alexcatdad/bmw-corpus)\n";
  assert.equal(normalized.toString("utf8"), expected);
  assert.equal(receipt.output.sha256, sha256Bytes(new TextEncoder().encode(expected)));
  assert.equal(receipt.fixture, true);
  assert.deepEqual(await readFile(path.join(corpus, capture.manifest.artifact.path)), source);
  process.stdout.write(`${JSON.stringify({ fixture: true, liveAcquisition: false, nativeCliReplay: true, inputSha256: receipt.input.sha256, outputSha256: receipt.output.sha256 })}\n`);
} finally {
  await rm(corpus, { recursive: true, force: true });
}
