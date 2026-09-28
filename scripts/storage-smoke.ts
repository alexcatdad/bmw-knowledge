import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { FunctionReturnType } from "convex/server";
import type { internal } from "../convex/_generated/api.js";
import { devCli, invokeDevFunction as invoke, loadLocalEnvironment, personalDevTarget } from "./maintainer-cli.js";

type Configuration = FunctionReturnType<typeof internal.collection.getConfiguration>;
type Status = FunctionReturnType<typeof internal.collection.getStatus>;
type Submission = FunctionReturnType<typeof internal.collection.submitSource>;
type Inspection = FunctionReturnType<typeof internal.acquisition.inspectStaging>;

// Fixed, project-owned test bytes. This smoke cannot select a real source.
const fixtureUrl = "https://raw.githubusercontent.com/alexcatdad/bmw-knowledge/859254a54abb2f02e133e548bd960a440b0a9671/fixtures/http-source.html";
const fixtureHash = "80d7e96d7d1bbd2f643c4dd99b6204682610a68dfb17ba8fb12fc0af5e15c303";
loadLocalEnvironment();

async function settled(jobId: string, minimumAttempt: number): Promise<NonNullable<Status>> {
  const deadline = Date.now() + 9 * 60_000;
  while (Date.now() < deadline) {
    const status = await invoke<Status>("collection:getStatus", { jobId });
    assert(status, "The fixture job must exist.");
    if (status.job.attempt >= minimumAttempt && ["failed", "succeeded", "skipped"].includes(status.job.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Fixture action did not settle within its execution budget. Inspect its job before retrying.");
}

async function main(): Promise<void> {
  const deployment = personalDevTarget();
  const before = await invoke<Configuration>("collection:getConfiguration", {});
  assert.equal(before.workerMode, "convex");
  assert.equal(before.stagingBackend, "convex");
  assert.equal(before.policy.approvals.length, 0, "Use a personal dev deployment with no source approvals.");
  assert.equal(before.configuration.find((item) => item.name === "COLLECTION_APPROVALS_JSON")?.configured, false);
  assert.equal(before.configuration.find((item) => item.name === "CORPUS_GITHUB_TOKEN")?.configured, false,
    "This smoke proves retained storage on publication failure; it must not publish.");
  const expected = await readFile(new URL("../fixtures/http-source.html", import.meta.url));
  assert.equal(createHash("sha256").update(expected).digest("hex"), fixtureHash);
  const response = await fetch(fixtureUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200);
  const remote = new Uint8Array(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(remote).digest("hex"), fixtureHash);
  assert.equal(remote.byteLength, expected.byteLength);

  const approval = [{
    origin: new URL(fixtureUrl).origin,
    pathPrefix: new URL(fixtureUrl).pathname,
    approvedBy: "Codex: project-owned fixture for Alex's requested POC storage implementation",
    basis: "Project-owned integration test page; contains no BMW evidence. Public software fixture only.",
    approvedAt: new Date().toISOString(),
    fixture: true,
  }];
  const approvalJson = JSON.stringify(approval);
  let installed = false;
  try {
    installed = true;
    await devCli(["env", "set", "COLLECTION_APPROVALS_JSON", approvalJson], true);
    const input = {
      url: fixtureUrl,
      idempotencyKey: `convex-storage-fixture-${randomUUID()}`,
      title: "INTEGRATION FIXTURE: native Convex storage",
      relevance: "Verify retained raw bytes and stable retry after missing publisher configuration; no BMW findings.",
      series: ["E30"],
      reacquire: true,
    };
    const submitted = await invoke<Submission>("collection:submitSource", input, true);
    assert(submitted.jobId);
    assert.equal((await invoke<Submission>("collection:submitSource", input, true)).jobId, submitted.jobId);
    const first = await settled(submitted.jobId, 1);
    assert.equal(first.job.status, "failed");
    assert.equal(first.job.error?.code, "WORKER_CONFIGURATION");
    assert.equal(first.job.phase, "staged");
    assert.equal(first.capture?.status, "staged");
    assert.equal(first.capture?.stagingBackend, "convex");
    assert(first.capture?.storageId);
    assert(first.capture.manifest);
    assert.equal(first.capture.manifest.fixture, true);
    assert.equal(first.capture.manifest.artifact.sha256, fixtureHash);
    assert.equal(first.capture.manifest.artifact.byteLength, expected.byteLength);
    assert.equal(first.capture.publication, undefined);
    const inspection = await invoke<Inspection>("acquisition:inspectStaging", { jobId: submitted.jobId });
    assert.equal(inspection.verified, true);
    assert.equal(inspection.sha256, fixtureHash);
    assert.equal(inspection.byteLength, expected.byteLength);
    await invoke("collection:retryJob", { jobId: submitted.jobId }, true);
    const second = await settled(submitted.jobId, 2);
    assert.equal(second.job.status, "failed");
    assert.equal(second.job.error?.code, "WORKER_CONFIGURATION");
    assert.equal(second.job.phase, "staged");
    assert.equal(second.capture?._id, first.capture._id);
    assert.equal(second.capture?.storageId, first.capture.storageId);
    assert.equal(second.artifact?._id, first.artifact?._id);
    assert.deepEqual(second.capture?.manifest, first.capture.manifest);
    const retryInspection = await invoke<Inspection>("acquisition:inspectStaging", { jobId: submitted.jobId });
    assert.deepEqual(retryInspection, inspection);
    console.log(JSON.stringify({ deployment, jobId: submitted.jobId, captureId: first.capture._id,
      sourceId: submitted.sourceId, inspection, attempts: second.job.attempt,
      publication: "failed: publisher credential absent", originalRetained: true,
      retryReusedFile: true, fixture: true }, null, 2));
  } finally {
    if (installed) {
      const current = await invoke<Configuration>("collection:getConfiguration", {});
      if (isDeepStrictEqual(current.policy.approvals, approval)) {
        await devCli(["env", "remove", "COLLECTION_APPROVALS_JSON"], true);
      } else if (current.policy.approvals.length !== 0 ||
        current.configuration.find((item) => item.name === "COLLECTION_APPROVALS_JSON")?.configured !== false) {
        throw new Error("Source approvals changed during the smoke; preserved the newer setting. Inspect configuration.");
      }
    }
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Native storage fixture smoke failed.");
  process.exitCode = 1;
});
