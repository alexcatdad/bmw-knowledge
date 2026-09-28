import type { CollectionPolicy, SourceApproval } from "./policy.js";

export interface SourceMetadata {
  id: string;
  url: string;
  title?: string;
  relevance: string;
  series: Array<"E30" | "E46">;
}

export interface CollectRequest {
  source: SourceMetadata;
  jobId: string;
  captureId: string;
}

export interface CaptureManifest {
  schemaVersion: 1;
  kind: "http_response_capture";
  source: SourceMetadata;
  jobId: string;
  captureId: string;
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  http: {
    status: number;
    contentType: string;
    contentLength: number | null;
    etag: string | null;
    lastModified: string | null;
  };
  redirects: string[];
  artifact: {
    sha256: string;
    byteLength: number;
    mediaType: string;
    path: string;
  };
  approval: SourceApproval;
  fixture: boolean;
  completeness: string;
}

export interface StoredCapture {
  manifest: CaptureManifest;
  bytes: Uint8Array;
}

export interface GitHubPublication {
  owner: string;
  repo: string;
  branch: string;
  commitSha: string;
  artifactPath: string;
  manifestPath: string;
  artifactUrl: string;
  manifestUrl: string;
}

export interface Staging {
  load(captureId: string): Promise<StoredCapture | null>;
  save(capture: StoredCapture): Promise<void>;
}

export interface Publisher {
  publish(capture: StoredCapture): Promise<GitHubPublication>;
}

export interface CollectionDependencies {
  policy: CollectionPolicy;
  staging: Staging;
  publisher: Publisher;
  onStaged: (manifest: CaptureManifest) => Promise<void>;
  /** A saved Convex checkpoint must be resumed from its exact original staging envelope. */
  expectedManifest?: CaptureManifest;
  fetch?: typeof globalThis.fetch;
  /** Optional action-wide budget, in addition to the source and adapter deadlines. */
  signal?: AbortSignal;
}
