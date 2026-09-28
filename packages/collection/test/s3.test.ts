import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3Staging, manifestBytes } from "../src/index.js";
import { captureFixture } from "./helpers.js";

class S3FixtureClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly commands: Array<GetObjectCommand | PutObjectCommand> = [];
  readonly lostAcknowledgements = new Set<string>();

  async send(command: GetObjectCommand | PutObjectCommand): Promise<unknown> {
    this.commands.push(command);
    const key = command.input.Key ?? "";
    if (command instanceof GetObjectCommand) {
      const bytes = this.objects.get(key);
      if (bytes === undefined) throw Object.assign(new Error("secret upstream request details"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      return {
        ContentLength: bytes.byteLength,
        Body: { transformToWebStream: () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } }) },
      };
    }
    expect(command.input.IfNoneMatch).toBe("*");
    if (this.objects.has(key)) throw Object.assign(new Error("precondition provider details"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    if (!(command.input.Body instanceof Uint8Array)) throw new Error("Expected bytes.");
    this.objects.set(key, command.input.Body.slice());
    if (this.lostAcknowledgements.has(key)) throw new Error("PRIVATE acknowledged then disconnected");
    return {};
  }

  staging(): S3Staging {
    return new S3Staging({
      endpoint: "http://minio.home.lab:9000",
      bucket: "bmw-staging",
      region: "us-east-1",
      accessKeyId: "unit-test-access",
      secretAccessKey: "unit-test-secret",
      client: this as unknown as Pick<S3Client, "send">,
    });
  }
}

describe("S3-compatible durable staging", () => {
  it("uses configured private MinIO independently from public acquisition URL rules", () => {
    expect(() => new S3Staging({ endpoint: "http://10.0.10.21:9000", bucket: "bmw-staging", region: "us-east-1", accessKeyId: "unit-access", secretAccessKey: "unit-secret" })).not.toThrow();
  });

  it("writes raw bytes before the immutable envelope and verifies the durable capture", async () => {
    const sdk = new S3FixtureClient();
    const capture = captureFixture();
    await sdk.staging().save(capture);
    const writes = sdk.commands.filter((command) => command instanceof PutObjectCommand);
    expect(writes.map((command) => command.input.Key)).toEqual([
      `staging/raw/sha256/${capture.manifest.artifact.sha256}`,
      "staging/captures/capture-1.json",
    ]);
    expect(sdk.objects.get("staging/captures/capture-1.json")).toEqual(manifestBytes(capture.manifest));
    expect(await sdk.staging().load("capture-1")).toEqual(capture);
  });

  it("shares raw objects across captures without deleting staged evidence", async () => {
    const sdk = new S3FixtureClient();
    const staging = sdk.staging();
    await staging.save(captureFixture("same bytes", "capture-1"));
    await staging.save(captureFixture("same bytes", "capture-2"));
    expect(sdk.objects.size).toBe(3);
    expect(await staging.load("capture-1")).not.toBeNull();
    expect(await staging.load("capture-2")).not.toBeNull();
    expect(sdk.commands.every((command) => command instanceof GetObjectCommand || command instanceof PutObjectCommand)).toBe(true);
  });

  it("recovers lost write acknowledgements and exact repeated writes", async () => {
    const sdk = new S3FixtureClient();
    const capture = captureFixture();
    sdk.lostAcknowledgements.add(`staging/raw/sha256/${capture.manifest.artifact.sha256}`);
    sdk.lostAcknowledgements.add("staging/captures/capture-1.json");
    const staging = sdk.staging();
    await staging.save(capture);
    await staging.save(capture);
    expect(await staging.load("capture-1")).toEqual(capture);
  });

  it("never overwrites a stable envelope with a different capture", async () => {
    const sdk = new S3FixtureClient();
    const staging = sdk.staging();
    const original = captureFixture("original bytes");
    await staging.save(original);
    await expect(staging.save(captureFixture("different fetched bytes"))).rejects.toMatchObject({ code: "STAGING_CONTENT_CONFLICT" });
    expect(await staging.load("capture-1")).toEqual(original);
  });

  it("detects corrupted stored raw bytes rather than trusting envelope metadata", async () => {
    const sdk = new S3FixtureClient();
    const capture = captureFixture();
    await sdk.staging().save(capture);
    sdk.objects.set(`staging/raw/sha256/${capture.manifest.artifact.sha256}`, new TextEncoder().encode("corrupted bytes"));
    await expect(sdk.staging().load("capture-1")).rejects.toMatchObject({ code: "CAPTURE_INTEGRITY_FAILED" });
  });

  it("treats a missing capture as absent, but missing bytes as an incomplete capture", async () => {
    const sdk = new S3FixtureClient();
    expect(await sdk.staging().load("capture-1")).toBeNull();
    sdk.objects.set("staging/captures/capture-1.json", manifestBytes(captureFixture().manifest));
    await expect(sdk.staging().load("capture-1")).rejects.toMatchObject({ code: "STAGING_INCOMPLETE" });
  });

  it("checks capture-envelope identity and rejects malformed manifests", async () => {
    const sdk = new S3FixtureClient();
    sdk.objects.set("staging/captures/wrong-capture.json", manifestBytes(captureFixture().manifest));
    await expect(sdk.staging().load("wrong-capture")).rejects.toMatchObject({ code: "STAGED_CAPTURE_MISMATCH" });
    sdk.objects.set("staging/captures/capture-1.json", new TextEncoder().encode("not-json"));
    await expect(sdk.staging().load("capture-1")).rejects.toMatchObject({ code: "INVALID_STAGED_ENVELOPE" });
  });

  it("does not expose upstream S3 request details or credentials", async () => {
    const client = { send: async () => { throw new Error("SECRET accessKeyId=PRIVATE upstream body"); } } as unknown as Pick<S3Client, "send">;
    const staging = new S3Staging({ endpoint: "http://10.0.10.21:9000", bucket: "bmw-staging", region: "us-east-1", accessKeyId: "PRIVATE", secretAccessKey: "SECRET", client });
    await expect(staging.load("capture-1")).rejects.toMatchObject({ code: "STAGING_READ_FAILED", message: "S3 staging object could not be read." });
  });
});
