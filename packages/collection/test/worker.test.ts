import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollectionError, createWorkerAdapters, GitHubPublisher, S3Staging } from "../src/index.js";
import type { WorkerEnvironment } from "../src/index.js";
import { captureFixture } from "./helpers.js";

const corpus = { owner: "fixture-owner", repo: "fixture-corpus", branch: "proof/main" };
const configurationMessage = "Collection worker requires valid dedicated staging settings and the maintainer corpus target.";

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
