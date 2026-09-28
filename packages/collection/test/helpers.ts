import { createHash } from "node:crypto";
import type { CaptureManifest, CollectionPolicy, GitHubPublication, SourceApproval, StoredCapture } from "../src/index.js";

export const approval: SourceApproval = {
  origin: "https://example.com",
  pathPrefix: "/approved",
  approvedBy: "Alex",
  basis: "Project-owned test fixture approved for public redistribution.",
  approvedAt: "2026-09-28T09:00:00.000Z",
  fixture: true,
};

export const policy: CollectionPolicy = { approvals: [approval], maxBytes: 512 * 1024, timeoutMs: 15_000, maxRedirects: 3 };

export function captureFixture(body = "<h1>BMW collection fixture</h1>", captureId = "capture-1"): StoredCapture {
  const bytes = new TextEncoder().encode(body);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const manifest: CaptureManifest = {
    schemaVersion: 1,
    kind: "http_response_capture",
    source: { id: "source-1", url: "https://example.com/approved/rear-lights", title: "Fixture", relevance: "Fixture proving collection plumbing.", series: ["E30"] },
    jobId: "job-1",
    captureId,
    requestedUrl: "https://example.com/approved/rear-lights",
    finalUrl: "https://example.com/approved/rear-lights",
    retrievedAt: "2026-09-28T09:01:00.000Z",
    http: { status: 200, contentType: "text/html; charset=utf-8", contentLength: null, etag: null, lastModified: null },
    redirects: [],
    artifact: { sha256: hash, byteLength: bytes.byteLength, mediaType: "text/html", path: `raw/sha256/${hash}` },
    approval,
    fixture: true,
    completeness: "Complete HTTP response body; linked pages and attachments were not acquired.",
  };
  return { manifest, bytes };
}

export function publicationFixture(capture: StoredCapture): GitHubPublication {
  const commitSha = "f".repeat(40);
  const manifestPath = `captures/${capture.manifest.captureId}.json`;
  return {
    owner: "fixture-owner",
    repo: "fixture-corpus",
    branch: "main",
    commitSha,
    artifactPath: capture.manifest.artifact.path,
    manifestPath,
    artifactUrl: `https://github.com/fixture-owner/fixture-corpus/blob/${commitSha}/${capture.manifest.artifact.path}`,
    manifestUrl: `https://github.com/fixture-owner/fixture-corpus/blob/${commitSha}/${manifestPath}`,
  };
}
