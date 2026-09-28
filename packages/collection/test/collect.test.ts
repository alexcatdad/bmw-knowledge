import { afterEach, describe, expect, it, vi } from "vitest";
import { collectApprovedSource, CollectionError } from "../src/index.js";
import type { CollectionDependencies, CollectRequest, Publisher, Staging, StoredCapture } from "../src/index.js";
import { approval, captureFixture, policy, publicationFixture } from "./helpers.js";

class MemoryStaging implements Staging {
  readonly captures = new Map<string, StoredCapture>();
  async load(id: string): Promise<StoredCapture | null> { return this.captures.get(id) ?? null; }
  async save(capture: StoredCapture): Promise<void> { this.captures.set(capture.manifest.captureId, capture); }
}

function setup(fetcher: typeof fetch): { request: CollectRequest; dependencies: CollectionDependencies; staging: MemoryStaging; publisher: Publisher } {
  const capture = captureFixture();
  const request = { source: capture.manifest.source, jobId: capture.manifest.jobId, captureId: capture.manifest.captureId };
  const staging = new MemoryStaging();
  const publisher = { publish: vi.fn(async (stored: StoredCapture) => publicationFixture(stored)) };
  return { request, staging, publisher, dependencies: { policy, staging, publisher, onStaged: vi.fn(async () => undefined), fetch: fetcher } };
}

afterEach(() => vi.useRealTimers());

describe("bounded collection and durable retry", () => {
  it("preserves source bytes and checkpoints the durable capture before publishing", async () => {
    const bytes = new TextEncoder().encode("<h1>Original bytes</h1>\r\n");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, {
      headers: { "content-type": "text/html; charset=utf-8", "content-length": String(bytes.byteLength), etag: '"original"' },
    }));
    const { request, dependencies, staging } = setup(fetcher);
    dependencies.onStaged = vi.fn(async (manifest) => {
      expect((await staging.load(manifest.captureId))?.bytes).toEqual(bytes);
    });
    const result = await collectApprovedSource(request, dependencies);
    expect(result.manifest.http).toMatchObject({ contentLength: bytes.byteLength, etag: '"original"' });
    expect(result.manifest.fixture).toBe(true);
    expect(result.manifest.artifact.byteLength).toBe(bytes.byteLength);
    expect(dependencies.onStaged).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual", credentials: "omit", headers: { "Accept-Encoding": "identity" } });
  });

  it("checks an out-of-allowlist redirect before sending another request", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example.com/rear" } }));
    const { request, dependencies, staging, publisher } = setup(fetcher);
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "SOURCE_NOT_APPROVED" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(staging.captures.size).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects real-source redirects into a separately approved fixture before fetching fixture bytes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://fixtures.example.com/approved/rear" } }));
    const { request, dependencies, staging, publisher } = setup(fetcher);
    dependencies.policy = { ...policy, approvals: [{ ...approval, fixture: false, basis: "Real source redistribution granted." }, { ...approval, origin: "https://fixtures.example.com" }] };
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "REDIRECT_APPROVAL_CHANGED" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(staging.captures.size).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("records allowed redirect destinations and rejects an encoded traversal before resolution", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/approved/current" } }))
      .mockResolvedValueOnce(new Response("document", { headers: { "content-type": "text/plain" } }));
    const { request, dependencies } = setup(fetcher);
    const result = await collectApprovedSource(request, dependencies);
    expect(result.manifest.redirects).toEqual(["https://example.com/approved/current"]);
    expect(result.manifest.finalUrl).toBe("https://example.com/approved/current");
    const unsafe = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "/approved/%2e%2e/outside" } })));
    await expect(collectApprovedSource(unsafe.request, unsafe.dependencies)).rejects.toMatchObject({ code: "UNSAFE_SOURCE_URL" });
  });

  it("stops a redirect loop at the configured limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/approved/again" } }));
    const { request, dependencies } = setup(fetcher);
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("bounds streaming bytes without a Content-Length header", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); controller.close(); } });
    const { request, dependencies, staging } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })));
    dependencies.policy = { ...policy, maxBytes: 8 };
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(staging.captures.size).toBe(0);
  });

  it.each([201, 204, 206])("rejects unsupported successful HTTP status %i before reading or staging", async (status) => {
    const response = new Response(status === 204 ? null : "part", {
      status,
      headers: { "content-type": "text/plain", ...(status === 206 ? { "content-length": "4", "content-range": "bytes 0-3/100" } : {}) },
    });
    const reader = response.body === null ? null : vi.spyOn(response.body, "getReader");
    const { request, dependencies, staging, publisher } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "UNSUPPORTED_HTTP_STATUS" });
    if (reader !== null) expect(reader).not.toHaveBeenCalled();
    expect(staging.captures.size).toBe(0);
    expect(dependencies.onStaged).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it.each(["bytes 0-3/100", ""])("rejects any Content-Range on HTTP 200 before reading or staging", async (contentRange) => {
    const response = new Response("part", { headers: { "content-type": "text/plain", "content-length": "4", "content-range": contentRange } });
    const reader = vi.spyOn(response.body!, "getReader");
    const { request, dependencies, staging, publisher } = setup(vi.fn<typeof fetch>().mockResolvedValue(response));
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT_RANGE" });
    expect(reader).not.toHaveBeenCalled();
    expect(staging.captures.size).toBe(0);
    expect(dependencies.onStaged).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("uses the deadline for the body stream as well as the request", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([65])); } });
    const { request, dependencies, staging } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/plain" } })));
    const pending = collectApprovedSource(request, dependencies);
    const assertion = expect(pending).rejects.toMatchObject({ code: "FETCH_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
    expect(staging.captures.size).toBe(0);
  });

  it.each([
    [{ "content-type": "application/pdf" }, "document", "UNSUPPORTED_MEDIA_TYPE"],
    [{ "content-type": "text/html", "content-encoding": "gzip" }, "document", "UNSUPPORTED_CONTENT_ENCODING"],
    [{ "content-type": "text/plain", "content-length": "99999999" }, "document", "RESPONSE_TOO_LARGE"],
    [{ "content-type": "text/plain", "content-length": "1" }, "document", "INCOMPLETE_CAPTURE"],
  ] as const)("rejects unsupported or incomplete source responses", async (headers, body, code) => {
    const { request, dependencies } = setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers })));
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code });
  });

  it("reuses staged bytes and their retrieval time after GitHub failure with no refetch", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("captured once", { headers: { "content-type": "text/plain" } }));
    const { request, dependencies, staging } = setup(fetcher);
    const publisher = vi.fn<Publisher["publish"]>()
      .mockRejectedValueOnce(new CollectionError("GITHUB_WRITE_FAILED", "Publication unavailable."))
      .mockImplementation(async (capture) => publicationFixture(capture));
    dependencies.publisher = { publish: publisher };
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "GITHUB_WRITE_FAILED" });
    const original = (await staging.load(request.captureId))?.manifest.retrievedAt;
    const result = await collectApprovedSource(request, dependencies);
    expect(result.manifest.retrievedAt).toBe(original);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(publisher).toHaveBeenCalledTimes(2);
  });

  it("shares artifact identity across distinct source captures without merging provenance", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("same bytes", { headers: { "content-type": "text/plain" } }));
    const { request, dependencies } = setup(fetcher);
    const first = await collectApprovedSource(request, dependencies);
    const second = await collectApprovedSource({ ...request, captureId: "capture-2", jobId: "job-2", source: { ...request.source, id: "source-2", url: "https://example.com/approved/other" } }, dependencies);
    expect(first.manifest.artifact.sha256).toBe(second.manifest.artifact.sha256);
    expect(first.manifest.artifact.path).toBe(second.manifest.artifact.path);
    expect(first.manifest.captureId).not.toBe(second.manifest.captureId);
    expect(first.manifest.source.id).not.toBe(second.manifest.source.id);
  });

  it("rechecks approval before publishing a staged capture", async () => {
    const { request, dependencies, staging, publisher } = setup(vi.fn<typeof fetch>());
    await staging.save(captureFixture());
    dependencies.policy = { ...policy, approvals: [{ ...approval, basis: "Approval was replaced." }] };
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("never refetches or saves a new capture when the saved checkpoint envelope is missing", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { request, dependencies, staging, publisher } = setup(fetcher);
    dependencies.expectedManifest = captureFixture().manifest;
    const save = vi.spyOn(staging, "save");
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "STAGING_CHECKPOINT_MISSING" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(dependencies.onStaged).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("fails before checkpointing or publishing if staged provenance differs from the saved checkpoint", async () => {
    const { request, dependencies, staging, publisher } = setup(vi.fn<typeof fetch>());
    const original = captureFixture();
    await staging.save(original);
    dependencies.expectedManifest = { ...original.manifest, retrievedAt: "2026-09-28T09:02:00.000Z" };
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "STAGING_CHECKPOINT_MISMATCH" });
    expect(dependencies.onStaged).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("matches the complete source snapshot before resuming an immutable capture", async () => {
    const { request, dependencies, staging, publisher } = setup(vi.fn<typeof fetch>());
    await staging.save(captureFixture());
    await expect(collectApprovedSource({ ...request, source: { ...request.source, title: "Changed source title" } }, dependencies)).rejects.toMatchObject({ code: "STAGED_CAPTURE_MISMATCH" });
    expect(dependencies.onStaged).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("does not expose upstream error details", async () => {
    const { request, dependencies } = setup(vi.fn<typeof fetch>().mockRejectedValue(new Error("provider-token=SECRET source-private-body")));
    await expect(collectApprovedSource(request, dependencies)).rejects.toMatchObject({ code: "FETCH_FAILED", message: "Source acquisition did not complete." });
  });
});
