import { ConvexError, v } from "convex/values";
import { env } from "./_generated/server";

export const collectionExecutionModeValidator = v.union(v.literal("developer"), v.literal("convex"));
export type CollectionExecutionMode = "developer" | "convex";
export const collectionStagingBackendValidator = v.union(v.literal("convex"), v.literal("s3"));
export type CollectionStagingBackend = "convex" | "s3";

/** Only the maintainer's deployment configuration selects the acquisition runtime. */
export function collectionExecutionMode(): CollectionExecutionMode {
  const configured = env.COLLECTION_EXECUTION_MODE ?? "convex";
  if (configured !== "developer" && configured !== "convex") {
    throw new ConvexError({ code: "INVALID_EXECUTION_MODE", message: "Collection execution mode must be developer or convex." });
  }
  return configured;
}

export function collectionStagingBackend(): CollectionStagingBackend {
  const configured = env.COLLECTION_STAGING_BACKEND ?? "convex";
  if (configured !== "convex" && configured !== "s3") {
    throw new ConvexError({ code: "INVALID_STAGING_BACKEND", message: "Collection staging backend must be convex or s3." });
  }
  return configured;
}

/** Existing captures predate native staging and must retain their S3 identity. */
export function pinnedStagingBackend(capture: { stagingBackend?: CollectionStagingBackend }): CollectionStagingBackend {
  return capture.stagingBackend ?? "s3";
}
