import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import type { FunctionReturnType } from "convex/server";
import type { internal } from "../convex/_generated/api.js";
import {
  CollectionError,
  GitHubPublisher,
  S3Staging,
  collectApprovedSource,
} from "@bmw-knowledge/collection";
import { policyFromConfiguration } from "@bmw-knowledge/collection/policy";
import { parseConvexOutput } from "./cli-output.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
type Configuration = FunctionReturnType<typeof internal.collection.getConfiguration>;
type Claim = FunctionReturnType<typeof internal.collection.claimJob>;
type Status = FunctionReturnType<typeof internal.collection.getStatus>;

try {
  process.loadEnvFile(resolve(root, ".env.local"));
} catch (error) {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
}

const help = `Maintainer collection commands (personal Convex dev deployment only):
  pnpm collection config
  pnpm collection approval set <reviewed-json-file>
  pnpm collection submit --url <https-url> --key <unique-key> [--title <title>]
    [--relevance <note>] [--series E30 --series E46] [--reacquire]
  pnpm collection status [--job <job-id>] [--limit <1-100>]
  pnpm collection retry --job <job-id>
  pnpm collection worker --job <job-id>
  pnpm collection doctor

The one-shot worker needs private-network access to MinIO and dedicated local
S3 credentials plus a corpus-scoped GitHub token. It retains staged objects.
`;

function fail(message: string): never {
  throw new CollectionError("DEVELOPER_CONFIGURATION", message);
}

function target(): string {
  if (process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    fail("This developer command uses the signed-in CLI. Remove deployment-key overrides before selecting personal dev.");
  }
  const deployment = process.env.CONVEX_DEPLOYMENT?.match(/^dev:([a-z0-9-]+)$/)?.[1];
  if (!deployment) fail("CONVEX_DEPLOYMENT must select an existing personal dev deployment in .env.local.");
  return deployment;
}

async function cli(args: string[], mutating = false): Promise<string> {
  const deployment = target();
  if (mutating) console.error(`target: dev (${deployment}, maintainer developer command)`);
  const childEnvironment = { ...process.env };
  for (const key of Object.keys(childEnvironment)) {
    if (key.startsWith("S3_") || key === "CORPUS_GITHUB_TOKEN" || key === "PROCESSING_CALLBACK_SECRET") delete childEnvironment[key];
  }
  try {
    const result = await execute("pnpm", ["exec", "convex", ...args, "--deployment", deployment], {
      cwd: root,
      env: childEnvironment,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    });
    return result.stdout.trim();
  } catch {
    // CLI/provider errors can contain response bodies or credential details.
    fail(`Convex command ${args[0]} ${args[1] ?? ""} failed. Inspect the selected dev deployment's logs.`);
  }
}

async function invoke<T>(name: string, args: Record<string, unknown>, mutating = false): Promise<T> {
  const output = await cli(["run", name, JSON.stringify(args)], mutating);
  try {
    return parseConvexOutput(output) as T;
  } catch {
    fail(`Convex function ${name} returned an unexpected CLI result.`);
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) fail(`Set ${name} in the worker's ignored .env.local or scoped environment.`);
  return value;
}

function adapters(configuration: Configuration) {
  const accessKeyId = required("S3_ACCESS_KEY_ID");
  const bucket = required("S3_BUCKET");
  if (["workflow-dev", "minioadmin"].includes(accessKeyId) || bucket.startsWith("wfe-")) {
    fail("Use a dedicated BMW bucket and restricted application identity. Shared workflow/root credentials are excluded.");
  }
  const pathStyle = process.env.S3_FORCE_PATH_STYLE ?? "true";
  if (pathStyle !== "true" && pathStyle !== "false") fail("S3_FORCE_PATH_STYLE must be true or false.");
  for (const [name, expected] of Object.entries({
    CORPUS_GITHUB_OWNER: configuration.corpus.owner,
    CORPUS_GITHUB_REPO: configuration.corpus.repo,
    CORPUS_GITHUB_BRANCH: configuration.corpus.branch,
  })) {
    if (process.env[name] && process.env[name] !== expected) fail(`${name} disagrees with the Convex corpus target.`);
  }
  return {
    staging: new S3Staging({
      endpoint: required("S3_ENDPOINT"),
      bucket,
      region: process.env.S3_REGION ?? "us-east-1",
      accessKeyId,
      secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: pathStyle === "true",
    }),
    publisher: new GitHubPublisher({ ...configuration.corpus, token: required("CORPUS_GITHUB_TOKEN") }),
  };
}

async function worker(jobId: string): Promise<unknown> {
  const configuration = await invoke<Configuration>("collection:getConfiguration", {});
  // Missing local settings fail before claiming work.
  const dependencies = adapters(configuration);
  const claimed = await invoke<Claim>("collection:claimJob", { jobId }, true);
  if (!claimed) return { jobId, claimed: false, status: await invoke<Status>("collection:getStatus", { jobId }) };
  const { request, attempt } = claimed;
  try {
    const result = await collectApprovedSource(request, {
      ...dependencies,
      policy: configuration.policy,
      ...(claimed.manifest === null ? {} : { expectedManifest: claimed.manifest }),
      onStaged: async (manifest) => {
        await invoke("collection:recordStagedCapture", { jobId, attempt, manifest }, true);
      },
    });
    await invoke("collection:recordPublished", { jobId, attempt, publication: result.publication }, true);
    return await invoke<Status>("collection:getStatus", { jobId });
  } catch (error) {
    // A lost success acknowledgement must not turn an already-published job into failure.
    const status = await invoke<Status>("collection:getStatus", { jobId }).catch(() => null);
    if (status?.job.status === "succeeded") return status;
    const failure = error instanceof CollectionError
      ? { code: error.code, message: error.message }
      : { code: "WORKER_FAILED", message: "The worker failed before a verified publication checkpoint." };
    await invoke("collection:recordFailed", { jobId, attempt, ...failure }, true).catch(() => {
      console.error("The failure checkpoint could not be saved. Inspect the job before retrying.");
    });
    throw new CollectionError(failure.code, failure.message);
  }
}

async function doctor(): Promise<unknown> {
  const configuration = await invoke<Configuration>("collection:getConfiguration", {});
  const { staging } = adapters(configuration);
  // A missing probe key proves authenticated object reads without creating an object.
  await staging.load("connectivity-probe");
  const { owner, repo, branch } = configuration.corpus;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`, {
      headers: {
        Authorization: `Bearer ${required("CORPUS_GITHUB_TOKEN")}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    fail("The worker could not read the configured GitHub branch.");
  }
  if (!response.ok) fail(`GitHub branch read failed with HTTP ${response.status}.`);
  return {
    deployment: target(),
    worker: "developer",
    minioAuthenticatedRead: "ok",
    githubAuthenticatedRead: "ok",
    writeVerification: "The first collection verifies writes and the exact published commit.",
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      url: { type: "string" },
      key: { type: "string" },
      title: { type: "string" },
      relevance: { type: "string" },
      series: { type: "string", multiple: true },
      reacquire: { type: "boolean" },
      job: { type: "string" },
      limit: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command || command === "help") {
    process.stdout.write(help);
    return;
  }
  let result: unknown;
  switch (command) {
    case "config":
      result = {
        deployment: target(),
        server: await invoke<Configuration>("collection:getConfiguration", {}),
        workerConfiguration: [
          "S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_FORCE_PATH_STYLE",
          "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "CORPUS_GITHUB_TOKEN",
        ].map((name) => ({ name, configured: Boolean(process.env[name]?.trim()) })),
      };
      break;
    case "approval": {
      if (positionals[1] !== "set" || !positionals[2]) fail("Use approval set <reviewed-json-file>.");
      const json = await readFile(resolve(process.cwd(), positionals[2]), "utf8");
      const policy = policyFromConfiguration(json);
      result = await cli(["env", "set", "COLLECTION_APPROVALS_JSON", JSON.stringify(policy.approvals)], true);
      break;
    }
    case "submit": {
      if (!values.url || !values.key) fail("Submission requires --url and --key.");
      const series = values.series ?? ["E30", "E46"];
      if (series.some((entry) => entry !== "E30" && entry !== "E46")) fail("--series accepts E30 or E46.");
      result = await invoke("collection:submitSource", {
        url: values.url,
        idempotencyKey: values.key,
        relevance: values.relevance ?? "Maintainer developer submission",
        series: [...new Set(series)].sort(),
        ...(values.title === undefined ? {} : { title: values.title }),
        ...(values.reacquire ? { reacquire: true } : {}),
      }, true);
      break;
    }
    case "status": {
      const limit = Number(values.limit ?? "10");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("--limit must be between 1 and 100.");
      result = values.job
        ? await invoke<Status>("collection:getStatus", { jobId: values.job })
        : await invoke("collection:listJobs", { limit });
      break;
    }
    case "retry":
      if (!values.job) fail("Retry requires --job.");
      result = await invoke("collection:retryJob", { jobId: values.job }, true);
      break;
    case "worker":
      if (!values.job) fail("Worker requires --job.");
      result = await worker(values.job);
      break;
    case "doctor":
      result = await doctor();
      break;
    default:
      fail(`Unknown command ${command}. Use pnpm collection --help.`);
  }
  console.log(JSON.stringify(result, null, 2));
}

await main().catch((error: unknown) => {
  console.error(error instanceof CollectionError ? `${error.code}: ${error.message}` : "Developer command failed. Inspect local configuration and dev deployment logs.");
  process.exitCode = 1;
});
