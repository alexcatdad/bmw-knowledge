import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CollectionError } from "./errors.js";
import { manifestBytes, validateCaptureManifest, validateStoredCapture } from "./manifest.js";
import { assertRecordId } from "./paths.js";
import { MAX_CAPTURE_BYTES } from "./policy.js";
import { assertNotAborted, readResponseBytes, withAbort } from "./stream.js";
import type { Staging, StoredCapture } from "./types.js";

export interface S3StagingOptions {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Shared worker budget; request-specific deadlines still apply. */
  signal?: AbortSignal;
  /** Injection for adapter tests; normal use constructs the AWS SDK client. */
  client?: Pick<S3Client, "send">;
}

const MAX_MANIFEST_BYTES = 128 * 1024;
const S3_TIMEOUT_MS = 30_000;

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || (value.name !== "NoSuchBucket" && value.$metadata?.httpStatusCode === 404);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Durable source bytes and immutable capture envelopes. No cleanup occurs here. */
export class S3Staging implements Staging {
  private readonly client: Pick<S3Client, "send">;
  private readonly bucket: string;
  private readonly signal: AbortSignal | undefined;

  constructor(options: S3StagingOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new CollectionError("INVALID_STAGING_CONFIGURATION", "S3 staging endpoint must be an explicit HTTP or HTTPS URL.");
    }
    if (
      !["http:", "https:"].includes(endpoint.protocol) || endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/" ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || options.bucket.includes("..") ||
      options.region.trim().length === 0 || options.region.length > 64 ||
      options.accessKeyId.length === 0 || options.secretAccessKey.length === 0
    ) {
      throw new CollectionError("INVALID_STAGING_CONFIGURATION", "S3 staging requires an explicit endpoint, dedicated bucket, region and credentials.");
    }
    this.bucket = options.bucket;
    this.signal = options.signal;
    this.client = options.client ?? new S3Client({
      endpoint: endpoint.href,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: options.forcePathStyle ?? true,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: S3_TIMEOUT_MS },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 2,
    });
  }

  private async getBytes(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const controller = new AbortController();
    const signal = this.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, this.signal]);
    const timer = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);
    try {
      assertNotAborted(signal, "STAGING_TIMEOUT", "S3 staging read exceeded its deadline.");
      const result = await withAbort(
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal }),
        signal, "STAGING_TIMEOUT", "S3 staging read exceeded its deadline.",
      );
      if (result.Body === undefined) throw new CollectionError("STAGING_INCOMPLETE", "S3 staging returned an object without its body.");
      if (result.ContentLength !== undefined && result.ContentLength > maxBytes) {
        throw new CollectionError("STAGING_OBJECT_TOO_LARGE", "S3 staging object exceeds its supported size.");
      }
      return await readResponseBytes(new Response(result.Body.transformToWebStream()), maxBytes, signal, "STAGING_TIMEOUT");
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error instanceof CollectionError) throw error;
      if (signal.aborted) throw new CollectionError("STAGING_TIMEOUT", "S3 staging read exceeded its deadline.");
      throw new CollectionError("STAGING_READ_FAILED", "S3 staging object could not be read.");
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  private async writeImmutable(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const controller = new AbortController();
    const signal = this.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, this.signal]);
    const timer = setTimeout(() => controller.abort(), S3_TIMEOUT_MS);
    try {
      assertNotAborted(signal, "STAGING_TIMEOUT", "S3 staging write exceeded its deadline.");
      await withAbort(this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: contentType,
        IfNoneMatch: "*",
      }), { abortSignal: signal }), signal, "STAGING_TIMEOUT", "S3 staging write exceeded its deadline.");
    } catch {
      // A conditional conflict or a lost acknowledgement is safe only if the object is identical.
      const existing = await this.getBytes(key, Math.max(bytes.byteLength, MAX_MANIFEST_BYTES));
      if (existing === null) throw new CollectionError("STAGING_WRITE_FAILED", "S3 staging object could not be durably written.");
      if (!equalBytes(existing, bytes)) throw new CollectionError("STAGING_CONTENT_CONFLICT", "S3 staging already holds different bytes at the generated key.");
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  async load(captureId: string): Promise<StoredCapture | null> {
    assertRecordId(captureId);
    const envelopeBytes = await this.getBytes(`staging/captures/${captureId}.json`, MAX_MANIFEST_BYTES);
    if (envelopeBytes === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes));
    } catch {
      throw new CollectionError("INVALID_STAGED_ENVELOPE", "S3 capture envelope is not valid UTF-8 JSON.");
    }
    const manifest = validateCaptureManifest(value);
    if (manifest.captureId !== captureId) throw new CollectionError("STAGED_CAPTURE_MISMATCH", "S3 capture envelope does not match its stable capture identifier.");
    const bytes = await this.getBytes(`staging/raw/sha256/${manifest.artifact.sha256}`, MAX_CAPTURE_BYTES);
    if (bytes === null) throw new CollectionError("STAGING_INCOMPLETE", "S3 capture envelope references missing source bytes.");
    return validateStoredCapture({ manifest, bytes });
  }

  async save(capture: StoredCapture): Promise<void> {
    const validated = validateStoredCapture(capture);
    const envelope = manifestBytes(validated.manifest);
    if (envelope.byteLength > MAX_MANIFEST_BYTES) throw new CollectionError("STAGING_OBJECT_TOO_LARGE", "Capture envelope exceeds its supported size.");
    // Write source bytes first: an envelope never deliberately points to a not-yet-written object.
    await this.writeImmutable(`staging/raw/sha256/${validated.manifest.artifact.sha256}`, validated.bytes, validated.manifest.artifact.mediaType);
    await this.writeImmutable(`staging/captures/${validated.manifest.captureId}.json`, envelope, "application/json; charset=utf-8");
    const persisted = await this.load(validated.manifest.captureId);
    if (persisted === null || !equalBytes(manifestBytes(persisted.manifest), envelope)) {
      throw new CollectionError("STAGING_VERIFY_FAILED", "S3 staging did not retain the expected capture envelope.");
    }
  }
}
