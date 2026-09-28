import { CollectionError } from "./errors.js";
import { GitHubPublisher } from "./github.js";
import { S3Staging } from "./s3.js";

/** Explicit inputs fit both Node ProcessEnv and Convex's generated typed env. */
export interface WorkerEnvironment {
  S3_ENDPOINT?: string | undefined;
  S3_BUCKET?: string | undefined;
  S3_REGION?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE?: string | undefined;
  CORPUS_GITHUB_TOKEN?: string | undefined;
  CORPUS_GITHUB_OWNER?: string | undefined;
  CORPUS_GITHUB_REPO?: string | undefined;
  CORPUS_GITHUB_BRANCH?: string | undefined;
}

const CONFIGURATION_MESSAGE = "Collection worker requires valid dedicated staging settings and the maintainer corpus target.";

function required(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  return value;
}

function isReservedStagingName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "workflow-dev" || normalized === "minioadmin" || normalized.startsWith("wfe-");
}

/** Create the existing adapters without network IO or ambient credential lookup. */
export function createWorkerAdapters(
  environment: WorkerEnvironment,
  corpus: { owner: string; repo: string; branch: string },
  options: { signal?: AbortSignal } = {},
): { staging: S3Staging; publisher: GitHubPublisher } {
  try {
    const accessKeyId = required(environment.S3_ACCESS_KEY_ID);
    const bucket = required(environment.S3_BUCKET);
    const endpoint = required(environment.S3_ENDPOINT);
    const secretAccessKey = required(environment.S3_SECRET_ACCESS_KEY);
    const token = required(environment.CORPUS_GITHUB_TOKEN);
    const region = required(environment.S3_REGION ?? "us-east-1");
    const pathStyle = environment.S3_FORCE_PATH_STYLE ?? "true";
    if (isReservedStagingName(accessKeyId) || isReservedStagingName(bucket) || (pathStyle !== "true" && pathStyle !== "false")) {
      throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
    }
    const target = { owner: corpus.owner, repo: corpus.repo, branch: corpus.branch };
    for (const [declared, expected] of [
      [environment.CORPUS_GITHUB_OWNER, target.owner],
      [environment.CORPUS_GITHUB_REPO, target.repo],
      [environment.CORPUS_GITHUB_BRANCH, target.branch],
    ]) {
      if (declared !== undefined && declared !== expected) throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
    }
    const budget = options.signal === undefined ? {} : { signal: options.signal };
    const publisher = new GitHubPublisher({ ...target, token, ...budget });
    const staging = new S3Staging({ endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle: pathStyle === "true", ...budget });
    return { staging, publisher };
  } catch {
    // Constructor failures must not reveal endpoint values, credentials or SDK errors.
    throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  }
}
