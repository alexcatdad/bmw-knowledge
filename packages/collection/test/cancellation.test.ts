import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { collectApprovedSource, GitHubPublisher, S3Staging } from "../src/index.js";
import type { CollectionDependencies, StoredCapture } from "../src/index.js";
import { captureFixture, policy, publicationFixture } from "./helpers.js";

function latch() {
  let notify: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { notify = resolve; });
  return { ready, notify };
}

function collection(fetcher: typeof fetch, signal: AbortSignal) {
  const fixture = captureFixture();
  const request = { source: fixture.manifest.source, jobId: fixture.manifest.jobId, captureId: fixture.manifest.captureId };
  const staging = { load: vi.fn(async () => null), save: vi.fn(async (_capture: StoredCapture) => undefined) };
  const publisher = { publish: vi.fn(async (capture: StoredCapture) => publicationFixture(capture)) };
  const onStaged = vi.fn(async () => undefined);
  const dependencies: CollectionDependencies = { policy, staging, publisher, onStaged, fetch: fetcher, signal };
  return { request, dependencies, staging, publisher, onStaged };
}

function s3(client: { send: (...args: unknown[]) => Promise<unknown> }, signal: AbortSignal): S3Staging {
  return new S3Staging({ endpoint: "http://minio.home.lab:9000", bucket: "bmw-kb-dev", region: "us-east-1", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", client: client as unknown as Pick<S3Client, "send">, signal });
}

function github(fetcher: typeof fetch, signal: AbortSignal): GitHubPublisher {
  return new GitHubPublisher({ owner: "fixture-owner", repo: "fixture-corpus", branch: "main", token: "fixture-token", fetch: fetcher, signal });
}

function stalledBody(started: ReturnType<typeof latch>, cancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("unfinished body")); },
    pull() { started.notify(); },
    cancel,
  });
}

describe("action-wide collection cancellation", () => {
  it("rejects a pre-aborted collection before staging, fetch, checkpoint or publication", async () => {
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const fetcher = vi.fn<typeof fetch>();
    const run = collection(fetcher, controller.signal);
    await expect(collectApprovedSource(run.request, run.dependencies)).rejects.toMatchObject({ code: "WORKER_TIMEOUT", message: "Collection worker exceeded its total deadline." });
    for (const operation of [run.staging.load, run.staging.save, fetcher, run.onStaged, run.publisher.publish]) expect(operation).not.toHaveBeenCalled();
  });

  it("aborts an in-flight source request with the combined signal and no subsequent staging", async () => {
    const controller = new AbortController();
    const started = latch();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { started.notify(); return new Promise<Response>(() => undefined); });
    const run = collection(fetcher, controller.signal);
    const pending = collectApprovedSource(run.request, run.dependencies);
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "FETCH_TIMEOUT", message: "Source acquisition exceeded its deadline." });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(run.staging.save).not.toHaveBeenCalled();
    expect(run.publisher.publish).not.toHaveBeenCalled();
  });

  it("cancels a stalled source body using the parent budget rather than waiting for its source timer", async () => {
    const controller = new AbortController();
    const started = latch();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stalledBody(started, cancel), { headers: { "content-type": "text/plain" } }));
    const run = collection(fetcher, controller.signal);
    const pending = collectApprovedSource(run.request, run.dependencies);
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "FETCH_TIMEOUT", message: "The response did not complete before its deadline." });
    expect(cancel).toHaveBeenCalledOnce();
    expect(run.staging.save).not.toHaveBeenCalled();
    expect(run.onStaged).not.toHaveBeenCalled();
  });

  it("stops publication when the total budget expires after durable staging", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("complete", { headers: { "content-type": "text/plain" } }));
    const run = collection(fetcher, controller.signal);
    run.dependencies.onStaged = vi.fn(async () => { controller.abort(new Error("PRIVATE_ABORT_REASON")); });
    await expect(collectApprovedSource(run.request, run.dependencies)).rejects.toMatchObject({ code: "WORKER_TIMEOUT" });
    expect(run.staging.save).toHaveBeenCalledOnce();
    expect(run.publisher.publish).not.toHaveBeenCalled();
  });

  it("awaits an in-progress staged checkpoint after budget expiry before returning failure", async () => {
    const controller = new AbortController();
    const checkpointStarted = latch();
    const checkpointReleased = latch();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("complete", { headers: { "content-type": "text/plain" } }));
    const run = collection(fetcher, controller.signal);
    let checkpointFinished = false;
    run.dependencies.onStaged = vi.fn(async () => {
      checkpointStarted.notify();
      await checkpointReleased.ready;
      checkpointFinished = true;
    });
    let workerFinished = false;
    const completion = collectApprovedSource(run.request, run.dependencies).then(
      () => { workerFinished = true; return null; },
      (error: unknown) => { workerFinished = true; return error; },
    );
    await checkpointStarted.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(checkpointFinished).toBe(false);
    expect(workerFinished).toBe(false);
    expect(run.publisher.publish).not.toHaveBeenCalled();
    checkpointReleased.notify();
    expect(await completion).toMatchObject({ code: "WORKER_TIMEOUT", message: "Collection worker exceeded its total deadline." });
    expect(checkpointFinished).toBe(true);
    expect(run.publisher.publish).not.toHaveBeenCalled();
  });
});

describe("real S3 adapter cancellation", () => {
  it("checks an already aborted parent before any SDK read or write", async () => {
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const send = vi.fn(async () => { throw new Error("Unexpected SDK request"); });
    const staging = s3({ send }, controller.signal);
    await expect(staging.load("capture-1")).rejects.toMatchObject({ code: "STAGING_TIMEOUT" });
    await expect(staging.save(captureFixture())).rejects.toMatchObject({ code: "STAGING_TIMEOUT" });
    expect(send).not.toHaveBeenCalled();
  });

  it("aborts an in-flight SDK read with a safe error and no later request", async () => {
    const controller = new AbortController();
    const started = latch();
    const send = vi.fn(async (..._args: unknown[]) => { started.notify(); return new Promise<unknown>(() => undefined); });
    const pending = s3({ send }, controller.signal).load("capture-1");
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "STAGING_TIMEOUT", message: "S3 staging read exceeded its deadline." });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0]?.[1] as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(true);
  });

  it("does not start a recovery read or envelope write after aborting a raw PUT", async () => {
    const controller = new AbortController();
    const started = latch();
    const send = vi.fn(async (..._args: unknown[]) => { started.notify(); return new Promise<unknown>(() => undefined); });
    const pending = s3({ send }, controller.signal).save(captureFixture());
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "STAGING_TIMEOUT" });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
  });

  it("cancels a stalled SDK response body before reading a referenced raw object", async () => {
    const controller = new AbortController();
    const started = latch();
    const cancel = vi.fn();
    const send = vi.fn(async () => ({ Body: { transformToWebStream: () => stalledBody(started, cancel) } }));
    const pending = s3({ send }, controller.signal).load("capture-1");
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "STAGING_TIMEOUT", message: "The response did not complete before its deadline." });
    expect(cancel).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("real GitHub adapter cancellation", () => {
  it("checks an already aborted parent before any fetch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const fetcher = vi.fn<typeof fetch>();
    await expect(github(fetcher, controller.signal).publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_TIMEOUT", message: "GitHub publication request exceeded its deadline." });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts an in-flight GitHub read without starting a create", async () => {
    const controller = new AbortController();
    const started = latch();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { started.notify(); return new Promise<Response>(() => undefined); });
    const pending = github(fetcher, controller.signal).publish(captureFixture());
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "GITHUB_TIMEOUT", message: "GitHub publication request exceeded its deadline." });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("does not start a recovery read after an in-flight GitHub PUT is aborted", async () => {
    const controller = new AbortController();
    const started = latch();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockImplementationOnce(async () => { started.notify(); return new Promise<Response>(() => undefined); });
    const pending = github(fetcher, controller.signal).publish(captureFixture());
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    expect(fetcher.mock.calls.map(([_url, init]) => init?.method)).toEqual(["GET", "PUT"]);
  });

  it("cancels a stalled GitHub raw-response stream instead of creating or verifying more files", async () => {
    const controller = new AbortController();
    const started = latch();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stalledBody(started, cancel)));
    const pending = github(fetcher, controller.signal).publish(captureFixture());
    await started.ready;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "GITHUB_TIMEOUT", message: "The response did not complete before its deadline." });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
