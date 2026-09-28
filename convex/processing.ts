import {
  canonicalCaptureManifestText,
  processingManifestText,
  validateProcessingManifest,
} from "@bmw-knowledge/normalization/contract";
import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { corpusTarget } from "./corpus";
import { sha256, utf8 } from "./digests";
import schema from "./schema";
import {
  captureManifestValidator,
  processingFailureCodeValidator,
  processingManifestValidator,
  processingProofValidator,
  processingPublicationValidator,
  publicationValidator,
} from "./validators";

type ProcessingFailureCode = Infer<typeof processingFailureCodeValidator>;
type PublishedCapture = {
  capture: Doc<"captures"> & {
    manifest: Infer<typeof captureManifestValidator>;
    publication: Infer<typeof publicationValidator>;
    artifactId: Id<"artifacts">;
  };
  artifact: Doc<"artifacts">;
};

const FAILURE_MESSAGES: Record<ProcessingFailureCode, string> = {
  INVALID_CAPTURE: "The capture did not meet the normalization input contract.",
  INPUT_HASH_MISMATCH: "The input bytes or capture manifest did not match the recorded hashes.",
  UNSUPPORTED_MEDIA_TYPE: "The captured media type is not supported by this processor.",
  UNSUPPORTED_ENCODING: "The input encoding is not supported by this processor.",
  OUTPUT_LIMIT: "The normalized output exceeded the supported byte limit.",
  IO_ERROR: "The processor could not read or verify the required corpus files.",
};

function fail(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

function revision(value: string): void {
  if (!/^[a-f0-9]{40}$/.test(value)) fail("INVALID_PROCESSOR_REVISION", "A processor revision must be a full lowercase Git commit SHA.");
}

async function publishedCapture(ctx: QueryCtx, captureId: Id<"captures">): Promise<PublishedCapture | null> {
  const capture = await ctx.db.get("captures", captureId);
  if (!capture || capture.status !== "published" || !capture.manifest || !capture.publication || !capture.artifactId) return null;
  const artifact = await ctx.db.get("artifacts", capture.artifactId);
  if (!artifact || artifact.sha256 !== capture.manifest.artifact.sha256 || artifact.byteLength !== capture.manifest.artifact.byteLength || artifact.path !== capture.manifest.artifact.path) return null;
  return {
    capture: { ...capture, manifest: capture.manifest, publication: capture.publication, artifactId: capture.artifactId },
    artifact,
  };
}

export const getCaptureForVerification = internalQuery({
  args: { captureId: v.id("captures") },
  returns: v.union(v.null(), v.object({ capture: schema.doc("captures"), artifact: schema.doc("artifacts") })),
  handler: async (ctx, args) => await publishedCapture(ctx, args.captureId),
});

export const getResult = internalQuery({
  args: { captureId: v.id("captures"), processorRevision: v.string(), historyLimit: v.optional(v.number()) },
  returns: v.union(v.null(), v.object({ result: schema.doc("processingResults"), history: v.array(schema.doc("processingEvents")), historyTruncated: v.boolean() })),
  handler: async (ctx, args) => {
    revision(args.processorRevision);
    const limit = args.historyLimit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("INVALID_HISTORY_LIMIT", "History limits must be between one and one hundred.");
    const result = await ctx.db.query("processingResults").withIndex("by_captureId_and_processorRevision", (q) => q.eq("captureId", args.captureId).eq("processorRevision", args.processorRevision)).unique();
    if (!result) return null;
    const events = await ctx.db.query("processingEvents").withIndex("by_resultId", (q) => q.eq("resultId", result._id)).order("desc").take(limit + 1);
    return { result, history: events.slice(0, limit), historyTruncated: events.length > limit };
  },
});

export const recordSuccess = internalMutation({
  args: { manifest: processingManifestValidator, publication: processingPublicationValidator, proof: processingProofValidator },
  returns: v.object({ resultId: v.id("processingResults"), status: v.literal("succeeded"), replayed: v.boolean() }),
  handler: async (ctx, args) => {
    const manifest = validateProcessingManifest(args.manifest);
    const captureId = ctx.db.normalizeId("captures", manifest.captureId);
    const input = captureId ? await publishedCapture(ctx, captureId) : null;
    if (!input) fail("CAPTURE_NOT_PUBLISHED", "Normalization requires a published capture with a recorded artifact.");
    const capture = input.capture;
    if (manifest.input.sha256 !== input.artifact.sha256 || manifest.input.byteLength !== input.artifact.byteLength || manifest.input.artifactPath !== input.artifact.path || manifest.fixture !== capture.manifest.fixture) {
      fail("PROCESSING_INPUT_MISMATCH", "The processing input and fixture label must match the published capture.");
    }
    const target = corpusTarget();
    if (args.publication.owner !== target.owner || args.publication.repo !== target.repo || !/^[a-f0-9]{40}$/.test(args.publication.commitSha)) {
      fail("PROCESSING_PUBLICATION_MISMATCH", "Processing results must use an immutable revision of the configured corpus.");
    }
    const manifestHash = await sha256(utf8(canonicalCaptureManifestText(capture.manifest)));
    const receiptHash = await sha256(utf8(processingManifestText(manifest)));
    if (manifest.input.manifestSha256 !== manifestHash || args.proof.inputManifestSha256 !== manifestHash || args.proof.inputSha256 !== input.artifact.sha256 || args.proof.inputByteLength !== input.artifact.byteLength || args.proof.outputSha256 !== manifest.output.sha256 || args.proof.outputByteLength !== manifest.output.byteLength || args.proof.receiptSha256 !== receiptHash) {
      fail("PROCESSING_PROOF_MISMATCH", "The verified file hashes and lengths must match the published input and processing receipt.");
    }
    const existing = await ctx.db.query("processingResults").withIndex("by_captureId_and_processorRevision", (q) => q.eq("captureId", capture._id).eq("processorRevision", manifest.processor.revision)).unique();
    if (existing?.status === "succeeded") {
      if (!existing.manifest || processingManifestText(existing.manifest) !== processingManifestText(manifest)) {
        fail("PROCESSING_CONFLICT", "This capture and processor revision already have a different verified result.");
      }
      // A later corpus commit may contain the identical receipt and output.
      // Preserve the first verified publication and accept the replay.
      return { resultId: existing._id, status: "succeeded" as const, replayed: true };
    }
    const fields = { captureId: capture._id, processorRevision: manifest.processor.revision, inputSha256: input.artifact.sha256, status: "succeeded" as const, manifest, publication: args.publication, verifiedAt: Date.now(), updatedAt: Date.now() };
    const resultId = existing?._id ?? await ctx.db.insert("processingResults", fields);
    if (existing) await ctx.db.patch("processingResults", resultId, { ...fields, error: undefined });
    await ctx.db.insert("processingEvents", { resultId, eventKey: "success", status: "succeeded", publication: args.publication });
    return { resultId, status: "succeeded" as const, replayed: false };
  },
});

export const recordFailure = internalMutation({
  args: { captureId: v.id("captures"), inputSha256: v.string(), processorRevision: v.string(), code: processingFailureCodeValidator },
  returns: v.object({ resultId: v.id("processingResults"), status: v.union(v.literal("failed"), v.literal("succeeded")), duplicate: v.boolean(), ignored: v.boolean() }),
  handler: async (ctx, args) => {
    revision(args.processorRevision);
    const input = await publishedCapture(ctx, args.captureId);
    if (!input) fail("CAPTURE_NOT_PUBLISHED", "Normalization failures must refer to a published capture.");
    if (args.inputSha256 !== input.artifact.sha256) fail("PROCESSING_INPUT_MISMATCH", "The failure must identify the published capture's input hash.");
    const existing = await ctx.db.query("processingResults").withIndex("by_captureId_and_processorRevision", (q) => q.eq("captureId", args.captureId).eq("processorRevision", args.processorRevision)).unique();
    const eventKey = `failure:${args.code}`;
    const priorEvent = existing ? await ctx.db.query("processingEvents").withIndex("by_resultId_and_eventKey", (q) => q.eq("resultId", existing._id).eq("eventKey", eventKey)).unique() : null;
    if (priorEvent && existing) return { resultId: existing._id, status: existing.status, duplicate: true, ignored: existing.status === "succeeded" };
    if (existing?.status === "succeeded") {
      await ctx.db.insert("processingEvents", { resultId: existing._id, eventKey, status: "failed", code: args.code, ignored: true });
      return { resultId: existing._id, status: "succeeded" as const, duplicate: false, ignored: true };
    }
    const fields = { captureId: args.captureId, processorRevision: args.processorRevision, inputSha256: args.inputSha256, status: "failed" as const, error: { code: args.code, message: FAILURE_MESSAGES[args.code] }, updatedAt: Date.now() };
    const resultId = existing?._id ?? await ctx.db.insert("processingResults", fields);
    if (existing) await ctx.db.patch("processingResults", resultId, fields);
    await ctx.db.insert("processingEvents", { resultId, eventKey, status: "failed", code: args.code });
    return { resultId, status: "failed" as const, duplicate: false, ignored: false };
  },
});
