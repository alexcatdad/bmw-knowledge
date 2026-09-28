import { CollectionError } from "./errors.js";

export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function assertRecordId(id: string): void {
  if (!RECORD_ID_PATTERN.test(id)) {
    throw new CollectionError("INVALID_RECORD_ID", "Record identifiers must be safe opaque identifiers.");
  }
}

export function artifactPathForHash(sha256: string): string {
  if (!SHA256_PATTERN.test(sha256)) {
    throw new CollectionError("INVALID_ARTIFACT_HASH", "An artifact requires a lowercase SHA-256 hash.");
  }
  return `raw/sha256/${sha256}`;
}

export function manifestPathForCapture(captureId: string): string {
  assertRecordId(captureId);
  return `captures/${captureId}.json`;
}
