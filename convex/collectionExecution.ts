import { ConvexError, v } from "convex/values";
import { env } from "./_generated/server";

export const collectionExecutionModeValidator = v.union(v.literal("developer"), v.literal("convex"));
export type CollectionExecutionMode = "developer" | "convex";

/** Only the maintainer's deployment configuration selects the acquisition runtime. */
export function collectionExecutionMode(): CollectionExecutionMode {
  const configured = env.COLLECTION_EXECUTION_MODE ?? "developer";
  if (configured !== "developer" && configured !== "convex") {
    throw new ConvexError({ code: "INVALID_EXECUTION_MODE", message: "Collection execution mode must be developer or convex." });
  }
  return configured;
}
