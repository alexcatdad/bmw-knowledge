import { ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** Docs describe hex; verified hosted and test runtimes may use canonical base64. */
export function storageHashHex(value: string): string {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    try {
      const binary = atob(value);
      if (binary.length === 32 && btoa(binary) === value) {
        return Array.from(binary, (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
      }
    } catch { /* Malformed metadata is rejected below. */ }
  }
  throw new ConvexError({ code: "STORAGE_INTEGRITY_FAILED", message: "Native storage metadata did not match the capture's SHA-256 and length." });
}

export async function verifyStorageMetadata(
  ctx: Pick<QueryCtx, "db">,
  storageId: Id<"_storage">,
  expected: { sha256: string; byteLength: number },
): Promise<"hex" | "base64"> {
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) throw new ConvexError({ code: "STORAGE_FILE_MISSING", message: "The retained native capture file is unavailable." });
  if (metadata.size !== expected.byteLength || storageHashHex(metadata.sha256) !== expected.sha256) {
    throw new ConvexError({ code: "STORAGE_INTEGRITY_FAILED", message: "Native storage metadata did not match the capture's SHA-256 and length." });
  }
  return /^[a-f0-9]{64}$/.test(metadata.sha256) ? "hex" : "base64";
}
