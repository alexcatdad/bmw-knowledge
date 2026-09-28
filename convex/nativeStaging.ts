"use node";

import { CollectionError, manifestBytes, validateStoredCapture, type CaptureManifest, type Staging, type StoredCapture } from "@bmw-knowledge/collection";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

type State = FunctionReturnType<typeof internal.collection.getNativeStagingState>;
type Reusable = FunctionReturnType<typeof internal.collection.findNativeArtifact>;

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new CollectionError("WORKER_TIMEOUT", "Collection worker exceeded its total deadline.");
}

function sameManifest(left: CaptureManifest, right: CaptureManifest): boolean {
  const leftBytes = manifestBytes(left);
  const rightBytes = manifestBytes(right);
  return leftBytes.byteLength === rightBytes.byteLength && leftBytes.every((byte, index) => byte === rightBytes[index]);
}

/** Only callers with a server-resolved capture may read its retained bytes. */
export async function readNativeCapture(ctx: ActionCtx, manifest: CaptureManifest, storageId: Id<"_storage">): Promise<StoredCapture> {
  let blob: Blob | null;
  try { blob = await ctx.storage.get(storageId); }
  catch { throw new CollectionError("STAGING_READ_FAILED", "The retained native capture could not be read."); }
  if (!blob) throw new CollectionError("STORAGE_FILE_MISSING", "The retained native capture file is unavailable.");
  if (blob.size !== manifest.artifact.byteLength) throw new CollectionError("STORAGE_INTEGRITY_FAILED", "Retained native bytes did not match the capture's SHA-256 and length.");
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await blob.arrayBuffer()); }
  catch { throw new CollectionError("STAGING_READ_FAILED", "The retained native capture could not be read."); }
  return validateStoredCapture({ manifest, bytes });
}

/** Native bytes live in file storage; immutable context stays on the capture. */
export class NativeStaging implements Staging {
  private storageId: Id<"_storage"> | null = null;

  constructor(
    private readonly ctx: ActionCtx,
    private readonly claim: { jobId: Id<"jobs">; captureId: string; attempt: number },
    private readonly signal: AbortSignal,
  ) {}

  async load(captureId: string): Promise<StoredCapture | null> {
    active(this.signal);
    if (captureId !== this.claim.captureId) throw new CollectionError("STAGED_CAPTURE_MISMATCH", "Native staging does not match the reserved capture.");
    const state: State = await this.ctx.runQuery(internal.collection.getNativeStagingState, { jobId: this.claim.jobId, attempt: this.claim.attempt });
    active(this.signal);
    if (!state.manifest && !state.storageId) return null;
    if (!state.manifest || !state.storageId || state.captureId !== this.claim.captureId) throw new CollectionError("STAGING_CHECKPOINT_MISSING", "The retained native capture checkpoint is incomplete.");
    const capture = await readNativeCapture(this.ctx, state.manifest, state.storageId);
    active(this.signal);
    this.storageId = state.storageId;
    return capture;
  }

  private async record(manifest: CaptureManifest, storageId: Id<"_storage">): Promise<void> {
    let checkpointError: unknown;
    try {
      await this.ctx.runMutation(internal.collection.recordStagedCapture, { jobId: this.claim.jobId, attempt: this.claim.attempt, manifest, storageId });
    } catch (error) {
      // Explicit policy, stale-attempt and integrity denials are authoritative.
      // Only an unknown transport acknowledgement failure may use readback.
      if (error instanceof ConvexError || error instanceof CollectionError) throw error;
      checkpointError = error;
    }
    let state: State;
    try { state = await this.ctx.runQuery(internal.collection.getNativeStagingState, { jobId: this.claim.jobId, attempt: this.claim.attempt }); }
    catch (error) { throw checkpointError ?? error; }
    if (!state.manifest || !state.storageId || state.captureId !== this.claim.captureId || !sameManifest(state.manifest, manifest)) {
      if (checkpointError !== undefined) throw checkpointError;
      throw new CollectionError("STAGING_CHECKPOINT_MISMATCH", "The retained native checkpoint did not preserve the exact immutable capture.");
    }
    // A concurrent identical-content capture can select the artifact's earlier
    // file ID. Exact retries use this canonical reference, not a redundant blob.
    this.storageId = state.storageId;
  }

  async save(capture: StoredCapture): Promise<void> {
    active(this.signal);
    const verified = validateStoredCapture(capture);
    if (verified.manifest.captureId !== this.claim.captureId || verified.manifest.jobId !== this.claim.jobId) throw new CollectionError("STAGED_CAPTURE_MISMATCH", "Native staging does not match the reserved capture.");
    const reusable: Reusable = await this.ctx.runQuery(internal.collection.findNativeArtifact, { jobId: this.claim.jobId, attempt: this.claim.attempt, manifest: verified.manifest });
    active(this.signal);
    let storageId = reusable.storageId;
    if (storageId) {
      await readNativeCapture(this.ctx, verified.manifest, storageId);
      active(this.signal);
    } else {
      const blob = new Blob([verified.bytes.slice().buffer], { type: verified.manifest.artifact.mediaType });
      try { storageId = await this.ctx.storage.store(blob); }
      catch { throw new CollectionError("STAGING_WRITE_FAILED", "The native capture file could not be durably stored."); }
    }
    // Native store and DB writes cannot be cancelled. Once a store returns its
    // ID, settle its guarded manifest/reference checkpoint before handling an
    // expired budget. No original or redundant retained blob is deleted.
    await this.record(verified.manifest, storageId);
    active(this.signal);
  }

  async checkpoint(manifest: CaptureManifest): Promise<void> {
    active(this.signal);
    if (!this.storageId) throw new CollectionError("STAGING_CHECKPOINT_MISSING", "The retained native capture has no verified file reference.");
    await this.record(manifest, this.storageId);
    active(this.signal);
  }
}
