import { describe, expect, it } from "vitest";
import { manifestBytes } from "@bmw-knowledge/collection";
import { normalizeCapture } from "../src/index.js";
import { canonicalCaptureManifestText, MAX_OUTPUT_BYTES, normalizedPathForCapture, processingManifestBytes, processingManifestPathForCapture, validateProcessingManifest } from "../src/contract.js";
import { fixtureInput, PROCESSOR_REVISION, reversedObjectKeys } from "./helpers.js";

describe("versioned processing contract", () => {
  it("matches the exact published collection manifest serializer regardless of key order", () => {
    const manifest = fixtureInput().manifest;
    const expected = new TextDecoder().decode(manifestBytes(manifest));
    expect(canonicalCaptureManifestText(manifest)).toBe(expected);
    expect(canonicalCaptureManifestText(reversedObjectKeys(manifest))).toBe(expected);
    const { title: _title, ...withoutTitle } = manifest.source;
    const minimal = { ...manifest, source: withoutTitle };
    expect(canonicalCaptureManifestText(minimal)).toBe(new TextDecoder().decode(manifestBytes(minimal)));
  });

  it("serializes receipts deterministically and generates paths from validated identifiers", () => {
    const result = normalizeCapture(fixtureInput());
    expect(processingManifestBytes(reversedObjectKeys(result.manifest))).toEqual(processingManifestBytes(result.manifest));
    expect(normalizedPathForCapture("capture-1", PROCESSOR_REVISION, "text/markdown")).toBe(`normalized/capture-1/${PROCESSOR_REVISION}/document.md`);
    expect(processingManifestPathForCapture("capture-1", PROCESSOR_REVISION)).toBe(`processing/capture-1/${PROCESSOR_REVISION}.json`);
    expect(() => processingManifestPathForCapture("../../workflows", PROCESSOR_REVISION)).toThrow();
    expect(() => normalizedPathForCapture("capture-1", "main", "text/plain")).toThrow();
  });

  it("rejects arbitrary paths, mismatched hashes, unknown warnings, duplicates and unsupported versions", () => {
    const manifest = normalizeCapture(fixtureInput()).manifest;
    expect(validateProcessingManifest(manifest)).toEqual(manifest);
    expect(() => validateProcessingManifest({ ...manifest, output: { ...manifest.output, path: ".github/workflows/execute.yml" } })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, input: { ...manifest.input, sha256: "c".repeat(64) } })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, warnings: ["invented-warning"] })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, warnings: ["layout-not-preserved", "layout-not-preserved"] })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, processor: { ...manifest.processor, version: "0.2.0" } })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, output: { ...manifest.output, byteLength: MAX_OUTPUT_BYTES + 1 } })).toThrow();
    expect(() => validateProcessingManifest({ ...manifest, commitSha: "d".repeat(40) })).toThrow();
  });
});
