import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectApprovedSource, CollectionError, createWorkerAdapters, createWorkerPublisher, createWorkerStaging, GitHubPublisher, S3Staging } from "../src/index.js";
import type { StoredCapture, WorkerEnvironment } from "../src/index.js";
import { captureFixture, policy } from "./helpers.js";

const corpus = { owner: "fixture-owner", repo: "fixture-corpus", branch: "proof/main" };
const configurationMessage = "Collection worker requires valid dedicated staging settings and the maintainer corpus target.";
const publicationConfigurationMessage = "Corpus publication requires a configured GitHub credential and the maintainer target.";

function environment(): WorkerEnvironment {
  return { S3_ENDPOINT: "http://minio.home.lab:9000", S3_BUCKET: "bmw-kb-dev", S3_ACCESS_KEY_ID: "bmw-kb-dev", S3_SECRET_ACCESS_KEY: "fixture-staging-secret", CORPUS_GITHUB_TOKEN: "fixture-corpus-token" };
}

afterEach(() => vi.restoreAllMocks());

describe("shared Node worker adapter configuration", () => {
  it("constructs real adapters without IO, fits ProcessEnv, and applies region/path-style defaults", async () => {
    let client: S3Client | undefined;
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(function (this: S3Client) {
      client = this;
      throw Object.assign(new Error("Missing fixture probe"), { name: "NoSuchKey" });
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not exposed", { status: 403 }));
    const nodeEnvironment: NodeJS.ProcessEnv = { ...environment(), S3_REGION: undefined, S3_FORCE_PATH_STYLE: undefined };
    const adapters = createWorkerAdapters(nodeEnvironment, corpus);
    expect(adapters.staging).toBeInstanceOf(S3Staging);
    expect(adapters.publisher).toBeInstanceOf(GitHubPublisher);
    expect(send).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await adapters.staging.load("configuration-probe")).toBeNull();
    expect(client).toBeDefined();
    expect(await client!.config.region()).toBe("us-east-1");
    expect(client!.config.forcePathStyle).toBe(true);
    expect(await client!.config.credentials()).toMatchObject({ accessKeyId: "bmw-kb-dev", secretAccessKey: "fixture-staging-secret" });
    expect(await client!.config.endpoint?.()).toMatchObject({ protocol: "http:", hostname: "minio.home.lab", port: 9000 });
    expect(nodeEnvironment.S3_REGION).toBeUndefined();
    await expect(adapters.publisher.publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_READ_FAILED" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toContain("/repos/fixture-owner/fixture-corpus/contents/raw/sha256/");
    expect(new URL(String(url)).searchParams.get("ref")).toBe(corpus.branch);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-corpus-token");
    client!.destroy();
  });

  it("uses explicit matching target, region and false path-style settings unchanged", async () => {
    let client: S3Client | undefined;
    vi.spyOn(S3Client.prototype, "send").mockImplementation(function (this: S3Client) {
      client = this;
      throw Object.assign(new Error("Missing fixture probe"), { name: "NoSuchKey" });
    });
    const configured = Object.freeze({ ...environment(), S3_REGION: "eu-central-1", S3_FORCE_PATH_STYLE: "false", CORPUS_GITHUB_OWNER: corpus.owner, CORPUS_GITHUB_REPO: corpus.repo, CORPUS_GITHUB_BRANCH: corpus.branch });
    const adapters = createWorkerAdapters(configured, corpus);
    expect(await adapters.staging.load("configuration-probe")).toBeNull();
    expect(client!.config.forcePathStyle).toBe(false);
    expect(await client!.config.region()).toBe("eu-central-1");
    client!.destroy();
  });

  it.each(["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "CORPUS_GITHUB_TOKEN"] as const)("rejects missing or blank %s before any IO", (key) => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(() => { throw new Error("Unexpected SDK IO"); });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected GitHub IO"));
    for (const value of [undefined, "", " \t\n"]) {
      expect(() => createWorkerAdapters({ ...environment(), [key]: value }, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION", message: configurationMessage }));
    }
    expect(send).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("excludes shared workflow and root identities/buckets including whitespace or case disguises", () => {
    for (const value of ["workflow-dev", "minioadmin", "wfe-shared", " MINIOADMIN ", " Workflow-Dev ", "WFE-root"]) {
      for (const field of ["S3_BUCKET", "S3_ACCESS_KEY_ID"] as const) {
        expect(() => createWorkerAdapters({ ...environment(), [field]: value }, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION" }));
      }
    }
  });

  it("rejects invalid explicit switches/region and every declared corpus target mismatch", () => {
    for (const pathStyle of ["", "TRUE", "0", "false "]) expect(() => createWorkerAdapters({ ...environment(), S3_FORCE_PATH_STYLE: pathStyle }, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION" }));
    expect(() => createWorkerAdapters({ ...environment(), S3_REGION: " " }, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION" }));
    for (const field of ["CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH"] as const) {
      for (const declared of ["", "wrong-target"]) expect(() => createWorkerAdapters({ ...environment(), [field]: declared }, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION" }));
    }
  });

  it("redacts unsafe endpoint/constructor failures and never starts network IO", () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(() => { throw new Error("Unexpected SDK IO"); });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected GitHub IO"));
    const secret = "PRIVATE_CREDENTIAL_MARKER";
    for (const configured of [
      { ...environment(), S3_ENDPOINT: `http://user:${secret}@minio.home.lab:9000`, S3_SECRET_ACCESS_KEY: secret },
      { ...environment(), S3_ENDPOINT: secret, CORPUS_GITHUB_TOKEN: secret },
      { ...environment(), S3_BUCKET: `Bad-${secret}`, S3_SECRET_ACCESS_KEY: secret },
    ]) {
      let error: unknown;
      try { createWorkerAdapters(configured, corpus); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(CollectionError);
      expect(error).toMatchObject({ code: "WORKER_CONFIGURATION", message: configurationMessage });
      expect(String(error)).not.toContain(secret);
      expect(error).not.toHaveProperty("cause");
    }
    expect(() => createWorkerAdapters(environment(), { ...corpus, repo: "../unexpected" })).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION", message: configurationMessage }));
    expect(send).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards one parent signal to both real adapters and prevents IO when already aborted", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(() => { throw new Error("Unexpected SDK IO"); });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected GitHub IO"));
    const controller = new AbortController();
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    const adapters = createWorkerAdapters(environment(), corpus, { signal: controller.signal });
    await expect(adapters.staging.load("capture-1")).rejects.toMatchObject({ code: "STAGING_TIMEOUT" });
    await expect(adapters.publisher.publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_TIMEOUT" });
    expect(send).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("independent staging and deferred corpus publication", () => {
  it("does not read publisher settings, validate the target or start network IO until publish", async () => {
    const token = vi.fn(() => "fixture-corpus-token");
    const owner = vi.fn(() => corpus.owner);
    const configured: WorkerEnvironment = { get CORPUS_GITHUB_TOKEN() { return token(); } };
    const target = { get owner() { return owner(); }, repo: corpus.repo, branch: corpus.branch };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unexposed upstream details", { status: 403 }));
    const publisher = createWorkerPublisher(configured, target);
    expect(token).not.toHaveBeenCalled();
    expect(owner).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(publisher.publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_READ_FAILED" });
    expect(token).toHaveBeenCalledOnce();
    expect(owner).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toContain("/repos/fixture-owner/fixture-corpus/contents/raw/sha256/");
    expect(new URL(String(url)).searchParams.get("ref")).toBe(corpus.branch);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-corpus-token");
  });

  it("returns fixed missing-token errors only at publish without requiring S3 configuration", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected publisher IO"));
    for (const token of [undefined, "", " \t\n"]) {
      const publisher = createWorkerPublisher({ CORPUS_GITHUB_TOKEN: token }, corpus);
      await expect(publisher.publish(captureFixture())).rejects.toMatchObject({ code: "WORKER_CONFIGURATION", message: publicationConfigurationMessage });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves complete source bytes and the staged checkpoint before reporting unavailable publication credentials", async () => {
    const capture = captureFixture();
    const request = { source: capture.manifest.source, jobId: capture.manifest.jobId, captureId: capture.manifest.captureId };
    const captures = new Map<string, StoredCapture>();
    const events: string[] = [];
    const bytes = new TextEncoder().encode("Original source bytes\r\n");
    const sourceFetch = vi.fn<typeof fetch>().mockImplementation(async () => { events.push("fetch"); return new Response(bytes, { headers: { "content-type": "text/plain" } }); });
    const staging = {
      load: async (id: string) => captures.get(id) ?? null,
      save: async (stored: StoredCapture) => { events.push("staged"); captures.set(stored.manifest.captureId, stored); },
    };
    const configured: WorkerEnvironment = { get CORPUS_GITHUB_TOKEN() { events.push("publisher_configuration"); return undefined; } };
    const publisher = createWorkerPublisher(configured, corpus);
    const checkpoint = vi.fn(async () => { events.push("checkpoint"); expect(captures.get(request.captureId)?.bytes).toEqual(bytes); });
    const publisherFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected publisher IO"));
    expect(events).toEqual([]);
    await expect(collectApprovedSource(request, { policy, staging, publisher, onStaged: checkpoint, fetch: sourceFetch })).rejects.toMatchObject({ code: "WORKER_CONFIGURATION", message: publicationConfigurationMessage });
    expect(events).toEqual(["fetch", "staged", "checkpoint", "publisher_configuration"]);
    expect(sourceFetch).toHaveBeenCalledOnce();
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(captures.get(request.captureId)?.bytes).toEqual(bytes);
    expect(captures.get(request.captureId)?.manifest).toMatchObject({ fixture: true, captureId: request.captureId, http: { status: 200 }, artifact: { byteLength: bytes.byteLength } });
    expect(publisherFetch).not.toHaveBeenCalled();
  });

  it("defers and redacts declared target mismatches and invalid publisher configuration", async () => {
    const marker = "PRIVATE_CONFIGURATION_MARKER";
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected publisher IO"));
    for (const field of ["CORPUS_GITHUB_OWNER", "CORPUS_GITHUB_REPO", "CORPUS_GITHUB_BRANCH"] as const) {
      const publisher = createWorkerPublisher({ CORPUS_GITHUB_TOKEN: marker, [field]: marker }, corpus);
      await expect(publisher.publish(captureFixture())).rejects.toMatchObject({ code: "WORKER_CONFIGURATION", message: publicationConfigurationMessage });
    }
    const invalid = createWorkerPublisher({ CORPUS_GITHUB_TOKEN: marker }, { ...corpus, repo: `../${marker}` });
    await expect(invalid.publish(captureFixture())).rejects.toMatchObject({ code: "WORKER_CONFIGURATION", message: publicationConfigurationMessage });
    const throwing: WorkerEnvironment = { get CORPUS_GITHUB_TOKEN(): string { throw new Error(marker); } };
    const deferred = createWorkerPublisher(throwing, corpus);
    const error: unknown = await deferred.publish(captureFixture()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectionError);
    expect(error).toMatchObject({ code: "WORKER_CONFIGURATION", message: publicationConfigurationMessage });
    expect(String(error)).not.toContain(marker);
    expect(error).not.toHaveProperty("cause");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("constructs standalone S3 staging without reading or requiring corpus credentials", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(() => { throw Object.assign(new Error("Missing fixture probe"), { name: "NoSuchKey" }); });
    const token = vi.fn((): string => { throw new Error("PRIVATE_CORPUS_CREDENTIAL"); });
    const stagingConfiguration: WorkerEnvironment = { ...environment(), get CORPUS_GITHUB_TOKEN() { return token(); }, CORPUS_GITHUB_REPO: "unrelated-target" };
    const staging = createWorkerStaging(stagingConfiguration);
    expect(staging).toBeInstanceOf(S3Staging);
    expect(token).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await staging.load("configuration-probe")).toBeNull();
    expect(token).not.toHaveBeenCalled();
    expect(() => createWorkerStaging({ ...environment(), S3_ACCESS_KEY_ID: "workflow-dev" })).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION", message: configurationMessage }));
    const withoutToken = { ...environment(), CORPUS_GITHUB_TOKEN: undefined };
    expect(() => createWorkerStaging(withoutToken)).not.toThrow();
    expect(() => createWorkerAdapters(withoutToken, corpus)).toThrowError(expect.objectContaining({ code: "WORKER_CONFIGURATION", message: configurationMessage }));
  });

  it("checks a pre-aborted lazy publisher before configuration getters or network requests", async () => {
    const controller = new AbortController();
    const token = vi.fn(() => "fixture-corpus-token");
    const configured: WorkerEnvironment = { get CORPUS_GITHUB_TOKEN() { return token(); } };
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected publisher IO"));
    const publisher = createWorkerPublisher(configured, corpus, { signal: controller.signal });
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(publisher.publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_TIMEOUT", message: "GitHub publication request exceeded its deadline." });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes the shared budget to the existing publisher during an in-flight request", async () => {
    const controller = new AbortController();
    let notify: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { notify(); return new Promise<Response>(() => undefined); });
    const publisher = createWorkerPublisher({ CORPUS_GITHUB_TOKEN: "fixture-corpus-token" }, corpus, { signal: controller.signal });
    const pending = publisher.publish(captureFixture());
    await started;
    controller.abort(new Error("PRIVATE_ABORT_REASON"));
    await expect(pending).rejects.toMatchObject({ code: "GITHUB_TIMEOUT", message: "GitHub publication request exceeded its deadline." });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
