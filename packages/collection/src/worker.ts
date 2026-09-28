import { CollectionError } from "./errors.js";
import { GitHubPublisher } from "./github.js";
import { S3Staging } from "./s3.js";
import type { S3StagingOptions } from "./s3.js";
import { assertNotAborted } from "./stream.js";
import type { Publisher } from "./types.js";

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
const PUBLICATION_CONFIGURATION_MESSAGE = "Corpus publication requires a configured GitHub credential and the maintainer target.";
type CorpusTarget = { owner: string; repo: string; branch: string };
type WorkerOptions = { signal?: AbortSignal };

function required(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  return value;
}

function isReservedStagingName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "workflow-dev" || normalized === "minioadmin" || normalized.startsWith("wfe-");
}

function stagingOptions(environment: WorkerEnvironment, options: WorkerOptions): S3StagingOptions {
  const accessKeyId = required(environment.S3_ACCESS_KEY_ID);
  const bucket = required(environment.S3_BUCKET);
  const endpoint = required(environment.S3_ENDPOINT);
  const secretAccessKey = required(environment.S3_SECRET_ACCESS_KEY);
  const region = required(environment.S3_REGION ?? "us-east-1");
  const pathStyle = environment.S3_FORCE_PATH_STYLE ?? "true";
  if (isReservedStagingName(accessKeyId) || isReservedStagingName(bucket) || (pathStyle !== "true" && pathStyle !== "false")) {
    throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  }
  return { endpoint, bucket, region, accessKeyId, secretAccessKey, forcePathStyle: pathStyle === "true", ...(options.signal === undefined ? {} : { signal: options.signal }) };
}

function configuredPublisher(environment: WorkerEnvironment, corpus: CorpusTarget, options: WorkerOptions): GitHubPublisher {
  try {
    const token = required(environment.CORPUS_GITHUB_TOKEN);
    const target = { owner: corpus.owner, repo: corpus.repo, branch: corpus.branch };
    for (const [declared, expected] of [
      [environment.CORPUS_GITHUB_OWNER, target.owner],
      [environment.CORPUS_GITHUB_REPO, target.repo],
      [environment.CORPUS_GITHUB_BRANCH, target.branch],
    ]) {
      if (declared !== undefined && declared !== expected) throw new CollectionError("WORKER_CONFIGURATION", PUBLICATION_CONFIGURATION_MESSAGE);
    }
    return new GitHubPublisher({ ...target, token, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  } catch {
    throw new CollectionError("WORKER_CONFIGURATION", PUBLICATION_CONFIGURATION_MESSAGE);
  }
}

/** S3 settings are independent of publication credentials and target selection. */
export function createWorkerStaging(environment: WorkerEnvironment, options: WorkerOptions = {}): S3Staging {
  try {
    return new S3Staging(stagingOptions(environment, options));
  } catch {
    throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  }
}

/** Defer publication configuration until captured bytes and provenance are staged. */
export function createWorkerPublisher(environment: WorkerEnvironment, corpus: CorpusTarget, options: WorkerOptions = {}): Publisher {
  return {
    async publish(capture) {
      assertNotAborted(options.signal, "GITHUB_TIMEOUT", "GitHub publication request exceeded its deadline.");
      return configuredPublisher(environment, corpus, options).publish(capture);
    },
  };
}

/** Eager preflight compatibility for an explicitly configured S3 developer worker. */
export function createWorkerAdapters(environment: WorkerEnvironment, corpus: CorpusTarget, options: WorkerOptions = {}): { staging: S3Staging; publisher: GitHubPublisher } {
  try {
    const settings = stagingOptions(environment, options);
    const publisher = configuredPublisher(environment, corpus, options);
    return { staging: new S3Staging(settings), publisher };
  } catch {
    // Constructor failures must not reveal endpoint values, credentials or SDK errors.
    throw new CollectionError("WORKER_CONFIGURATION", CONFIGURATION_MESSAGE);
  }
}
