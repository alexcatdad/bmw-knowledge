import { CollectionError } from "./errors.js";
import { manifestBytes, validateStoredCapture } from "./manifest.js";
import { manifestPathForCapture } from "./paths.js";
import { MAX_CAPTURE_BYTES } from "./policy.js";
import { assertNotAborted, readResponseBytes, withAbort } from "./stream.js";
import type { GitHubPublication, Publisher, StoredCapture } from "./types.js";

export interface GitHubPublisherOptions {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** Shared worker budget; request-specific deadlines still apply. */
  signal?: AbortSignal;
  /** Injection for deterministic Contents API adapter tests. */
  fetch?: typeof globalThis.fetch;
}

const GITHUB_TIMEOUT_MS = 30_000;
const MAX_API_JSON_BYTES = 128 * 1024;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export class GitHubPublisher implements Publisher {
  private readonly owner: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly signal: AbortSignal | undefined;

  constructor(options: GitHubPublisherOptions) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(options.owner) ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(options.repo) ||
      options.branch.length === 0 || options.branch.length > 200 || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(options.branch) ||
      options.branch.includes("..") || options.branch.includes("@{") || options.branch.includes("//") ||
      options.branch.startsWith("/") || options.branch.endsWith("/") || options.branch.endsWith(".") ||
      options.branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")) ||
      options.token.trim().length === 0
    ) {
      throw new CollectionError("INVALID_PUBLICATION_CONFIGURATION", "GitHub publication requires a configured owner, repository, branch and credential.");
    }
    this.owner = options.owner;
    this.repo = options.repo;
    this.branch = options.branch;
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
  }

  private apiUrl(suffix: string): string {
    return `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/${suffix}`;
  }

  private async requestBytes(url: string, method: "GET" | "PUT", accept: string, maxBytes: number, body?: string): Promise<{ status: number; bytes: Uint8Array }> {
    const controller = new AbortController();
    const signal = this.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, this.signal]);
    const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
    try {
      assertNotAborted(signal, "GITHUB_TIMEOUT", "GitHub publication request exceeded its deadline.");
      const response = await withAbort(this.fetcher(url, {
        method,
        redirect: "error",
        signal,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "bmw-knowledge/0.1 collection",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      }), signal, "GITHUB_TIMEOUT", "GitHub publication request exceeded its deadline.");
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        // No remote error body (which can echo secrets or source data) leaves this adapter.
        return { status: response.status, bytes: new Uint8Array() };
      }
      return { status: response.status, bytes: await readResponseBytes(response, maxBytes, signal, "GITHUB_TIMEOUT") };
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      if (signal.aborted) throw new CollectionError("GITHUB_TIMEOUT", "GitHub publication request exceeded its deadline.");
      throw new CollectionError("GITHUB_REQUEST_FAILED", "GitHub publication request did not complete.");
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }

  private async readFile(path: string, ref: string): Promise<Uint8Array | null> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.requestBytes(
      this.apiUrl(`contents/${encodedPath}?ref=${encodeURIComponent(ref)}`), "GET", "application/vnd.github.raw+json", MAX_CAPTURE_BYTES,
    );
    if (response.status === 404) return null;
    if (response.status !== 200) throw new CollectionError("GITHUB_READ_FAILED", `GitHub content verification returned HTTP ${response.status}.`);
    return response.bytes;
  }

  private async createFile(path: string, bytes: Uint8Array): Promise<void> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const body = JSON.stringify({ message: `Capture approved source: ${path}`, content: Buffer.from(bytes).toString("base64"), branch: this.branch });
    const response = await this.requestBytes(this.apiUrl(`contents/${encodedPath}`), "PUT", "application/vnd.github+json", MAX_API_JSON_BYTES, body);
    if (response.status !== 201) {
      throw new CollectionError("GITHUB_WRITE_FAILED", `GitHub content creation returned HTTP ${response.status}.`);
    }
  }

  private async ensureFile(path: string, expected: Uint8Array): Promise<void> {
    const existing = await this.readFile(path, this.branch);
    if (existing !== null) {
      if (!equalBytes(existing, expected)) throw new CollectionError("GITHUB_CONTENT_CONFLICT", "GitHub already holds different bytes at the generated corpus path.");
      return;
    }
    try {
      // Omit sha: this is create-only and must never update a pre-existing corpus object.
      await this.createFile(path, expected);
    } catch {
      // Covers create races and acceptance followed by a lost acknowledgement.
      const recovered = await this.readFile(path, this.branch);
      if (recovered === null) throw new CollectionError("GITHUB_WRITE_FAILED", "GitHub did not retain the expected corpus object after creation.");
      if (!equalBytes(recovered, expected)) throw new CollectionError("GITHUB_CONTENT_CONFLICT", "GitHub holds different bytes after a corpus creation conflict.");
    }
  }

  private async branchHead(): Promise<string> {
    const response = await this.requestBytes(this.apiUrl(`git/ref/heads/${encodeURIComponent(this.branch)}`), "GET", "application/vnd.github+json", MAX_API_JSON_BYTES);
    if (response.status !== 200) throw new CollectionError("GITHUB_REVISION_FAILED", `GitHub branch lookup returned HTTP ${response.status}.`);
    let commit: unknown;
    try {
      commit = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.bytes));
    } catch {
      throw new CollectionError("GITHUB_REVISION_FAILED", "GitHub branch lookup returned an invalid result.");
    }
    const object = typeof commit === "object" && commit !== null ? (commit as { object?: unknown }).object : undefined;
    const sha = typeof object === "object" && object !== null ? (object as { sha?: unknown }).sha : undefined;
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new CollectionError("GITHUB_REVISION_FAILED", "GitHub did not return an immutable commit identifier.");
    return sha;
  }

  async publish(capture: StoredCapture): Promise<GitHubPublication> {
    const validated = validateStoredCapture(capture);
    const artifactPath = validated.manifest.artifact.path;
    const manifestPath = manifestPathForCapture(validated.manifest.captureId);
    const envelope = manifestBytes(validated.manifest);
    await this.ensureFile(artifactPath, validated.bytes);
    await this.ensureFile(manifestPath, envelope);
    const commitSha = await this.branchHead();
    // These two reads use one explicit immutable revision, not the moving branch.
    const publishedArtifact = await this.readFile(artifactPath, commitSha);
    const publishedManifest = await this.readFile(manifestPath, commitSha);
    if (
      publishedArtifact === null || publishedManifest === null ||
      !equalBytes(publishedArtifact, validated.bytes) || !equalBytes(publishedManifest, envelope)
    ) {
      throw new CollectionError("GITHUB_VERIFY_FAILED", "Expected artifact and capture manifest were not verified at the publication revision.");
    }
    const baseUrl = `https://github.com/${this.owner}/${this.repo}/blob/${commitSha}`;
    return {
      owner: this.owner,
      repo: this.repo,
      branch: this.branch,
      commitSha,
      artifactPath,
      manifestPath,
      artifactUrl: `${baseUrl}/${artifactPath}`,
      manifestUrl: `${baseUrl}/${manifestPath}`,
    };
  }
}
