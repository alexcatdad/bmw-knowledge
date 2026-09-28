import { describe, expect, it, vi } from "vitest";
import { GitHubPublisher, manifestBytes } from "../src/index.js";
import { captureFixture } from "./helpers.js";

class GitHubFixtureApi {
  readonly files = new Map<string, Uint8Array>();
  readonly revisions = new Map<string, Map<string, Uint8Array>>();
  readonly requests: Array<{ url: URL; method: string; init: RequestInit }> = [];
  readonly lostAcknowledgements = new Set<string>();
  readonly createConflicts = new Set<string>();
  readonly corruptImmutableReads = new Set<string>();
  private revision = 1;

  get head(): string { return this.revision.toString(16).padStart(40, "0"); }

  readonly fetch = vi.fn<typeof fetch>().mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    this.requests.push({ url, method, init });
    expect(url.origin).toBe("https://api.github.com");
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      this.revisions.set(this.head, new Map([...this.files].map(([path, bytes]) => [path, bytes.slice()])));
      return Response.json({ ref: "refs/heads/main", object: { type: "commit", sha: this.head } });
    }
    const marker = "/contents/";
    const index = url.pathname.indexOf(marker);
    if (index === -1) throw new Error("Unexpected fixture API route.");
    const path = decodeURIComponent(url.pathname.slice(index + marker.length));
    if (method === "GET") {
      const ref = url.searchParams.get("ref") ?? "main";
      expect(new Headers(init.headers).get("accept")).toBe("application/vnd.github.raw+json");
      const files = ref === "main" ? this.files : this.revisions.get(ref);
      const bytes = files?.get(path);
      if (bytes === undefined) return new Response("sensitive provider error body", { status: 404 });
      if (ref !== "main" && this.corruptImmutableReads.has(path)) return new Response("wrong bytes at immutable revision");
      return new Response(bytes.slice());
    }
    const body = JSON.parse(String(init.body)) as { content: string; branch: string; sha?: string };
    expect(body.branch).toBe("main");
    expect(body.sha).toBeUndefined();
    if (this.createConflicts.has(path)) this.files.set(path, new TextEncoder().encode("concurrently created different bytes"));
    if (this.files.has(path)) return new Response("sensitive provider error body", { status: 422 });
    this.files.set(path, new Uint8Array(Buffer.from(body.content, "base64")));
    this.revision++;
    if (this.lostAcknowledgements.has(path)) throw new Error("token=PRIVATE provider acknowledged then disconnected");
    return Response.json({ commit: { sha: this.head } }, { status: 201 });
  });

  publisher(): GitHubPublisher {
    return new GitHubPublisher({ owner: "fixture-owner", repo: "fixture-corpus", branch: "main", token: "unit-test-secret", fetch: this.fetch });
  }
}

describe("GitHub Contents API publication", () => {
  it("creates raw bytes before the manifest and verifies both at an immutable SHA", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    const publication = await api.publisher().publish(capture);
    expect(publication.commitSha).toBe(api.head);
    expect(publication.artifactUrl).toBe(`https://github.com/fixture-owner/fixture-corpus/blob/${api.head}/${capture.manifest.artifact.path}`);
    expect(publication.manifestUrl).toBe(`https://github.com/fixture-owner/fixture-corpus/blob/${api.head}/captures/capture-1.json`);
    expect(api.files.get(capture.manifest.artifact.path)).toEqual(capture.bytes);
    expect(api.files.get("captures/capture-1.json")).toEqual(manifestBytes(capture.manifest));
    expect(api.requests.filter((request) => request.method === "PUT").map((request) => request.url.pathname)).toEqual([
      `/repos/fixture-owner/fixture-corpus/contents/${capture.manifest.artifact.path}`,
      "/repos/fixture-owner/fixture-corpus/contents/captures/capture-1.json",
    ]);
    const immutableReads = api.requests.filter((request) => request.url.searchParams.get("ref") === publication.commitSha);
    expect(immutableReads).toHaveLength(2);
    expect(api.requests.every((request) => new Headers(request.init.headers).get("x-github-api-version") === "2026-03-10")).toBe(true);
  });

  it("is idempotent for exact existing files and never issues an update", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    const publisher = api.publisher();
    const first = await publisher.publish(capture);
    const second = await publisher.publish(capture);
    expect(second).toEqual(first);
    expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  });

  it.each(["artifact", "manifest"] as const)("refuses mismatched existing %s bytes without overwriting them", async (kind) => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    const path = kind === "artifact" ? capture.manifest.artifact.path : "captures/capture-1.json";
    const wrong = new TextEncoder().encode("previous corpus data must survive");
    api.files.set(path, wrong);
    await expect(api.publisher().publish(capture)).rejects.toMatchObject({ code: "GITHUB_CONTENT_CONFLICT" });
    expect(api.files.get(path)).toEqual(wrong);
    expect(api.requests.some((request) => request.method === "PUT" && request.url.pathname.endsWith(path))).toBe(false);
  });

  it("recovers a lost create acknowledgement by rereading the expected object", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    api.lostAcknowledgements.add(capture.manifest.artifact.path);
    api.lostAcknowledgements.add("captures/capture-1.json");
    await expect(api.publisher().publish(capture)).resolves.toMatchObject({ commitSha: "3".padStart(40, "0") });
    expect(api.requests.filter((request) => request.method === "PUT")).toHaveLength(2);
  });

  it("detects conflicting create races rather than replacing the winner", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    api.createConflicts.add(capture.manifest.artifact.path);
    await expect(api.publisher().publish(capture)).rejects.toMatchObject({ code: "GITHUB_CONTENT_CONFLICT" });
    expect(new TextDecoder().decode(api.files.get(capture.manifest.artifact.path))).toBe("concurrently created different bytes");
  });

  it("fails if branch content cannot be verified at the explicit publication revision", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture();
    api.corruptImmutableReads.add("captures/capture-1.json");
    await expect(api.publisher().publish(capture)).rejects.toMatchObject({ code: "GITHUB_VERIFY_FAILED" });
  });

  it("uses raw media retrieval for artifacts larger than the JSON Contents API limit", async () => {
    const api = new GitHubFixtureApi();
    const capture = captureFixture("a".repeat(1_100_000));
    await expect(api.publisher().publish(capture)).resolves.toMatchObject({ artifactPath: capture.manifest.artifact.path });
    expect(api.files.get(capture.manifest.artifact.path)?.byteLength).toBe(1_100_000);
  });

  it("keeps upstream secrets and error bodies out of exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("token=PRIVATE raw-error-body", { status: 403 }));
    const publisher = new GitHubPublisher({ owner: "fixture-owner", repo: "fixture-corpus", branch: "main", token: "PRIVATE", fetch: fetcher });
    await expect(publisher.publish(captureFixture())).rejects.toMatchObject({ code: "GITHUB_READ_FAILED", message: "GitHub content verification returned HTTP 403." });
  });
});
