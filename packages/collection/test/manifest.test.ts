import { describe, expect, it } from "vitest";
import { validateCaptureManifest, validateStoredCapture } from "../src/index.js";
import { captureFixture } from "./helpers.js";

describe("versioned corpus manifest", () => {
  it("contains inspectable provenance without an S3 locator or its own commit SHA", () => {
    const capture = captureFixture();
    expect(validateCaptureManifest(capture.manifest)).toEqual(capture.manifest);
    expect(() => validateCaptureManifest({ ...capture.manifest, commitSha: "a".repeat(40) })).toThrow();
    expect(() => validateCaptureManifest({ ...capture.manifest, s3Bucket: "private-bucket" })).toThrow();
  });

  it("rejects a caller-selected repository path and inconsistent fixture provenance", () => {
    const capture = captureFixture();
    expect(() => validateCaptureManifest({ ...capture.manifest, artifact: { ...capture.manifest.artifact, path: ".github/workflows/execute.yml" } })).toThrow();
    expect(() => validateCaptureManifest({ ...capture.manifest, fixture: false })).toThrow();
  });

  it("validates actual bytes against the manifest hash and length", () => {
    const capture = captureFixture();
    expect(() => validateStoredCapture({ ...capture, bytes: new Uint8Array(capture.bytes.byteLength) })).toThrow();
  });

  it.each([201, 204, 206])("rejects a resumed manifest with HTTP status %i despite matching raw bytes", (status) => {
    const capture = captureFixture("part");
    const partial = { ...capture, manifest: { ...capture.manifest, http: { ...capture.manifest.http, status, contentLength: 4 } } };
    expect(() => validateCaptureManifest(partial.manifest)).toThrow();
    expect(() => validateStoredCapture(partial)).toThrow();
  });

  it("shares precise source and HTTP metadata bounds with the backend checkpoint", () => {
    const { manifest } = captureFixture();
    expect(validateCaptureManifest({ ...manifest, source: { ...manifest.source, relevance: "x".repeat(4000) }, completeness: "x".repeat(2048), http: { ...manifest.http, lastModified: "x".repeat(256), etag: "" } })).toMatchObject({ http: { lastModified: "x".repeat(256), etag: "" } });
    expect(() => validateCaptureManifest({ ...manifest, http: { ...manifest.http, lastModified: "x".repeat(257) } })).toThrow();
    expect(() => validateCaptureManifest({ ...manifest, http: { ...manifest.http, contentLength: manifest.artifact.byteLength + 1 } })).toThrow();
    expect(() => validateCaptureManifest({ ...manifest, finalUrl: "https://other.example.com/approved/rear", redirects: ["https://other.example.com/approved/rear"] })).toThrow();
  });
});
