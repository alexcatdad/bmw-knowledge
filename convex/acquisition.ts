"use node";

import { CollectionError, collectApprovedSource, createWorkerPublisher, createWorkerStaging } from "@bmw-knowledge/collection";
import type { FunctionReturnType } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, internalAction, type ActionCtx } from "./_generated/server";
import { collectionExecutionMode } from "./collectionExecution";
import { NativeStaging, readNativeCapture } from "./nativeStaging";

const WORKER_TIMEOUT_MS = 8 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;

// Only these fixed identifiers may cross the action boundary or enter state.
// Exception messages, response bodies, endpoint details and SDK diagnostics do not.
const FAILURE_CODES = [
  "WORKER_CONFIGURATION", "WORKER_TIMEOUT", "WORKER_FAILED", "FAILURE_CHECKPOINT_UNAVAILABLE",
  "JOB_NOT_FOUND", "STALE_WORKER_ATTEMPT", "SOURCE_NOT_APPROVED", "REDIRECT_APPROVAL_CHANGED",
  "INVALID_RECORD_ID", "INVALID_SOURCE_METADATA", "INVALID_SOURCE_URL", "UNSAFE_SOURCE_URL",
  "UNEXPECTED_REDIRECT", "TOO_MANY_REDIRECTS", "INVALID_REDIRECT", "HTTP_STATUS_FAILED",
  "UNSUPPORTED_HTTP_STATUS", "UNSUPPORTED_CONTENT_RANGE", "UNSUPPORTED_MEDIA_TYPE", "UNSUPPORTED_CONTENT_ENCODING",
  "INVALID_HTTP_METADATA", "RESPONSE_TOO_LARGE", "INCOMPLETE_CAPTURE", "FETCH_TIMEOUT", "FETCH_FAILED",
  "STAGED_CAPTURE_MISMATCH", "APPROVAL_CHANGED", "STAGED_CAPTURE_OUTSIDE_POLICY", "STAGING_CHECKPOINT_MISSING",
  "STAGING_CHECKPOINT_MISMATCH", "INVALID_CAPTURE_MANIFEST", "CAPTURE_INTEGRITY_FAILED", "INVALID_ARTIFACT_HASH",
  "STAGING_TIMEOUT", "STAGING_INCOMPLETE", "STAGING_OBJECT_TOO_LARGE", "STAGING_READ_FAILED", "STAGING_WRITE_FAILED",
  "STAGING_CONTENT_CONFLICT", "INVALID_STAGED_ENVELOPE", "STAGING_VERIFY_FAILED",
  "GITHUB_TIMEOUT", "GITHUB_REQUEST_FAILED", "GITHUB_READ_FAILED", "GITHUB_WRITE_FAILED", "GITHUB_CONTENT_CONFLICT",
  "GITHUB_REVISION_FAILED", "GITHUB_VERIFY_FAILED", "CAPTURE_NOT_RESERVED", "CAPTURE_IDENTITY_MISMATCH",
  "CAPTURE_URL_MISMATCH", "CAPTURE_APPROVAL_MISMATCH", "REDIRECT_NOT_APPROVED", "INVALID_CAPTURE",
  "CAPTURE_LENGTH_MISMATCH", "INVALID_ARTIFACT_PATH", "UNSUPPORTED_CONTENT_TYPE", "CAPTURE_IMMUTABLE",
  "ARTIFACT_IDENTITY_MISMATCH", "CAPTURE_NOT_STAGED", "PUBLICATION_TARGET_MISMATCH", "INVALID_PUBLICATION",
  "PUBLICATION_PATH_MISMATCH", "PUBLICATION_REVISION_MISMATCH", "PUBLICATION_IMMUTABLE",
  "STORAGE_FILE_MISSING", "STORAGE_INTEGRITY_FAILED", "STORAGE_REFERENCE_IMMUTABLE", "STAGING_BACKEND_MISMATCH",
] as const;
type FailureCode = (typeof FAILURE_CODES)[number];

const CONFIGURATION_CODES = [
  "INVALID_EXECUTION_MODE", "INVALID_CORPUS_CONFIGURATION", "INVALID_APPROVAL_CONFIGURATION", "INVALID_COLLECTION_LIMIT",
  "INVALID_STAGING_CONFIGURATION", "INVALID_PUBLICATION_CONFIGURATION", "WORKER_CONFIGURATION",
  "INVALID_STAGING_BACKEND",
] as const;

const resultValidator = v.object({
  jobId: v.id("jobs"),
  claimed: v.boolean(),
  status: v.union(v.literal("disabled"), v.literal("not_claimed"), v.literal("succeeded"), v.literal("failed")),
  errorCode: v.optional(v.union(...FAILURE_CODES.map((code) => v.literal(code)))),
});
type AcquisitionResult = Infer<typeof resultValidator>;
type Claim = FunctionReturnType<typeof internal.collection.claimJob>;
type Configuration = FunctionReturnType<typeof internal.collection.getConfiguration>;
type Status = FunctionReturnType<typeof internal.collection.getStatus>;

function failureCode(error: unknown): FailureCode {
  let code: unknown;
  if (error instanceof CollectionError) code = error.code;
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "object" && data !== null && "code" in data) code = data.code;
  }
  if (CONFIGURATION_CODES.some((candidate) => candidate === code)) return "WORKER_CONFIGURATION";
  return FAILURE_CODES.find((candidate) => candidate === code) ?? "WORKER_FAILED";
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new CollectionError("WORKER_TIMEOUT", "Collection exceeded its action deadline.");
}

async function recoverFailure(ctx: ActionCtx, jobId: Id<"jobs">, attempt: number, code: FailureCode): Promise<AcquisitionResult> {
  const observed: Status = await ctx.runQuery(internal.collection.getStatus, { jobId }).catch(() => null);
  // A commit followed by a lost acknowledgement is a completed job, even if
  // the caller saw an exception. Recovery never downgrades that publication.
  if (observed?.job.status === "succeeded" && observed.job.attempt === attempt && observed.capture?.status === "published") {
    return { jobId, claimed: true, status: "succeeded" };
  }
  if (observed && (observed.job.attempt !== attempt || observed.job.status !== "running")) {
    return { jobId, claimed: true, status: "failed", errorCode: "STALE_WORKER_ATTEMPT" };
  }
  try {
    await ctx.runMutation(internal.collection.recordFailed, {
      jobId, attempt, code,
      message: "Collection did not complete its verified publication checkpoint.",
    });
    return { jobId, claimed: true, status: "failed", errorCode: code };
  } catch {
    // A retry or publication can race the failure checkpoint. Its attempt guard
    // remains authoritative; report that the checkpoint was not acknowledged.
    const latest: Status = await ctx.runQuery(internal.collection.getStatus, { jobId }).catch(() => null);
    if (latest?.job.status === "succeeded" && latest.job.attempt === attempt && latest.capture?.status === "published") {
      return { jobId, claimed: true, status: "succeeded" };
    }
    if (latest?.job.status === "failed" && latest.job.attempt === attempt && latest.job.error?.code === code) {
      return { jobId, claimed: true, status: "failed", errorCode: code };
    }
    return { jobId, claimed: true, status: "failed", errorCode: latest && (latest.job.attempt !== attempt || latest.job.status !== "running") ? "STALE_WORKER_ATTEMPT" : "FAILURE_CHECKPOINT_UNAVAILABLE" };
  }
}

export const run = internalAction({
  args: { jobId: v.id("jobs") },
  returns: resultValidator,
  handler: async (ctx: ActionCtx, args: { jobId: Id<"jobs"> }): Promise<AcquisitionResult> => {
    let claimed: Claim;
    try {
      if (collectionExecutionMode() !== "convex") return { jobId: args.jobId, claimed: false, status: "disabled" };
      claimed = await ctx.runMutation(internal.collection.claimJob, { jobId: args.jobId });
    } catch (error) {
      return { jobId: args.jobId, claimed: false, status: "failed", errorCode: failureCode(error) };
    }
    if (claimed === null) {
      const observed: Status = await ctx.runQuery(internal.collection.getStatus, { jobId: args.jobId }).catch(() => null);
      if (observed?.job.status === "failed" && observed.job.error?.code === "WORKER_CONFIGURATION") {
        return { jobId: args.jobId, claimed: false, status: "failed", errorCode: "WORKER_CONFIGURATION" };
      }
      return { jobId: args.jobId, claimed: false, status: "not_claimed" };
    }
    const claim = claimed;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
    try {
      const configuration: Configuration = await ctx.runQuery(internal.collection.getConfiguration, {});
      requireActive(controller.signal);
      if (configuration.workerMode !== "convex") throw new CollectionError("WORKER_CONFIGURATION", "Collection execution mode changed before acquisition.");
      const nativeStaging = claim.stagingBackend === "convex" ? new NativeStaging(ctx, { jobId: args.jobId, captureId: claim.request.captureId, attempt: claim.attempt }, controller.signal) : null;
      const staging = nativeStaging ?? createWorkerStaging(env, { signal: controller.signal });
      const publisher = createWorkerPublisher(env, configuration.corpus, { signal: controller.signal });
      const result = await collectApprovedSource(claim.request, {
        staging, publisher,
        signal: controller.signal,
        policy: configuration.policy,
        ...(claim.manifest === null ? {} : { expectedManifest: claim.manifest }),
        onStaged: async (manifest) => {
          requireActive(controller.signal);
          if (nativeStaging) await nativeStaging.checkpoint(manifest);
          else await ctx.runMutation(internal.collection.recordStagedCapture, { jobId: args.jobId, attempt: claim.attempt, manifest });
        },
      });
      requireActive(controller.signal);
      await ctx.runMutation(internal.collection.recordPublished, { jobId: args.jobId, attempt: claim.attempt, publication: result.publication });
      return { jobId: args.jobId, claimed: true, status: "succeeded" };
    } catch (error) {
      return await recoverFailure(ctx, args.jobId, claim.attempt, controller.signal.aborted ? "WORKER_TIMEOUT" : failureCode(error));
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  },
});

const inspectionResultValidator = v.object({
  jobId: v.id("jobs"),
  stagingBackend: v.union(v.literal("convex"), v.literal("s3"), v.null()),
  status: v.union(v.literal("not_staged"), v.literal("verified"), v.literal("external"), v.literal("unavailable")),
  verified: v.boolean(),
  byteLength: v.union(v.number(), v.null()),
  sha256: v.union(v.string(), v.null()),
  fixture: v.union(v.boolean(), v.null()),
  retention: v.union(v.literal("retain"), v.null()),
  metadataHashEncoding: v.union(v.literal("hex"), v.literal("base64"), v.null()),
  errorCode: v.union(v.null(), v.union(...FAILURE_CODES.map((code) => v.literal(code)))),
});
type InspectionResult = Infer<typeof inspectionResultValidator>;
type InspectionState = FunctionReturnType<typeof internal.collection.getStagingInspection>;

export const inspectStaging = internalAction({
  args: { jobId: v.id("jobs") },
  returns: inspectionResultValidator,
  handler: async (ctx: ActionCtx, args: { jobId: Id<"jobs"> }): Promise<InspectionResult> => {
    const empty: InspectionResult = { jobId: args.jobId, stagingBackend: null, status: "not_staged", verified: false, byteLength: null, sha256: null, fixture: null, retention: null, metadataHashEncoding: null, errorCode: null };
    try {
      const state: InspectionState = await ctx.runQuery(internal.collection.getStagingInspection, args);
      if (!state.manifest) return { ...empty, stagingBackend: state.stagingBackend, retention: state.stagingBackend === null ? null : "retain" };
      const metadata = { stagingBackend: state.stagingBackend, byteLength: state.manifest.artifact.byteLength, sha256: state.manifest.artifact.sha256, fixture: state.manifest.fixture, retention: "retain" as const, metadataHashEncoding: state.metadataHashEncoding };
      if (state.stagingBackend === "s3") return { ...empty, ...metadata, status: "external" };
      if (!state.storageId) throw new CollectionError("STAGING_CHECKPOINT_MISSING", "The retained native capture has no verified file reference.");
      await readNativeCapture(ctx, state.manifest, state.storageId);
      return { ...empty, ...metadata, status: "verified", verified: true };
    } catch (error) {
      return { ...empty, status: "unavailable", errorCode: failureCode(error) };
    }
  },
});

const probeResultValidator = v.object({
  runtime: v.literal("convex-node"),
  endpointConfigured: v.boolean(),
  reachable: v.boolean(),
  httpStatus: v.union(v.number(), v.null()),
  errorCode: v.union(v.null(), v.literal("ENDPOINT_NOT_CONFIGURED"), v.literal("INVALID_ENDPOINT"), v.literal("PROBE_TIMEOUT"), v.literal("PROBE_FAILED"), v.literal("MINIO_UNHEALTHY")),
});
type ProbeResult = Infer<typeof probeResultValidator>;

export const probeMinio = internalAction({
  args: {},
  returns: probeResultValidator,
  handler: async (): Promise<ProbeResult> => {
    const result: ProbeResult = { runtime: "convex-node", endpointConfigured: false, reachable: false, httpStatus: null, errorCode: "ENDPOINT_NOT_CONFIGURED" };
    const configured = env.S3_ENDPOINT;
    if (configured === undefined || configured === "") return result;
    result.endpointConfigured = true;
    let endpoint: URL;
    try {
      endpoint = new URL(configured);
      if (configured.length > 2048 || /[\u0000-\u0020\u007f]/.test(configured) || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username !== "" || endpoint.password !== "" || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") throw new Error("invalid endpoint");
    } catch {
      return { ...result, errorCode: "INVALID_ENDPOINT" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(new URL("/minio/health/live", endpoint), { method: "GET", redirect: "error", signal: controller.signal });
      // Discard the body without reading it. No credential or endpoint value is
      // returned, logged, or copied into a diagnostic.
      await response.body?.cancel().catch(() => undefined);
      const httpStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      const reachable = httpStatus === 200 && !response.redirected;
      return { ...result, reachable, httpStatus, errorCode: reachable ? null : "MINIO_UNHEALTHY" };
    } catch {
      return { ...result, errorCode: controller.signal.aborted ? "PROBE_TIMEOUT" : "PROBE_FAILED" };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  },
});
