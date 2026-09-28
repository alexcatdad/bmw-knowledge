import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FunctionReturnType } from "convex/server";
import type { internal } from "../convex/_generated/api.js";
import {
  CollectionError,
  createWorkerAdapters,
  collectApprovedSource,
} from "@bmw-knowledge/collection";
import { policyFromConfiguration } from "@bmw-knowledge/collection/policy";
import { devCli as cli, invokeDevFunction as invoke, loadLocalEnvironment, personalDevTarget as target } from "./maintainer-cli.js";

type Configuration = FunctionReturnType<typeof internal.collection.getConfiguration>;
type Claim = FunctionReturnType<typeof internal.collection.claimJob>;
type Status = FunctionReturnType<typeof internal.collection.getStatus>;
type AcquisitionOutcome = FunctionReturnType<typeof internal.acquisition.run>;
type WorkerRuntime = "developer" | "convex";
type StagingBackend = "convex" | "s3";

loadLocalEnvironment();

const help = `Maintainer collection commands (personal Convex dev deployment only):
  pnpm collection config
  pnpm collection approval set <reviewed-json-file>
  pnpm collection submit --url <https-url> --key <unique-key> [--title <title>]
    [--relevance <note>] [--series E30 --series E46] [--reacquire]
  pnpm collection status [--job <job-id>] [--limit <1-100>]
  pnpm collection retry --job <job-id>
  pnpm collection runtime set <developer|convex>
  pnpm collection storage set <convex|s3>
  pnpm collection storage inspect --job <job-id>
  pnpm collection worker --job <job-id> [--runtime developer|convex]
  pnpm collection doctor [--runtime developer|convex]

The POC defaults to Convex execution and native Convex file storage. Source
approvals are still required. Staged originals survive publication failures.
GitHub publication requires a corpus-scoped deployment credential. Storage
inspection verifies an existing capture's bytes without returning a download URL.
Developer execution supports explicit S3 staging with dedicated credentials.
Doctor reports configuration; native storage writes are verified by collection.
`;

function fail(message: string): never {
  throw new CollectionError("DEVELOPER_CONFIGURATION", message);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) fail(`Set ${name} in the worker's ignored .env.local or scoped environment.`);
  return value;
}

function runtime(value: string): WorkerRuntime {
  if (value !== "developer" && value !== "convex") fail("The worker runtime must be developer or convex.");
  return value;
}

function stagingBackend(value: string): StagingBackend {
  if (value !== "convex" && value !== "s3") fail("The staging backend must be convex or s3.");
  return value;
}

async function worker(jobId: string, selectedRuntime?: WorkerRuntime): Promise<unknown> {
  const configuration = await invoke<Configuration>("collection:getConfiguration", {});
  if (selectedRuntime !== undefined && selectedRuntime !== configuration.workerMode) {
    fail("The requested runtime disagrees with the maintainer execution setting. Inspect collection config before running work.");
  }
  if (configuration.workerMode === "convex") {
    const execution = await invoke<AcquisitionOutcome>("acquisition:run", { jobId }, true, 9 * 60_000);
    if (execution.status === "failed") {
      throw new CollectionError(execution.errorCode ?? "WORKER_FAILED", "The Convex collection action failed. Inspect collection status before retrying.");
    }
    if (execution.status === "disabled") fail("Convex execution is disabled. Inspect collection config before running work.");
    return { execution, collection: await invoke<Status>("collection:getStatus", { jobId }) };
  }
  const priorStatus = await invoke<Status>("collection:getStatus", { jobId });
  const captureBackend = priorStatus?.capture
    ? (priorStatus.capture.stagingBackend ?? "s3") : configuration.stagingBackend;
  if (captureBackend !== "s3") {
    fail("Native Convex storage requires convex execution. Use runtime set convex, or explicitly select S3 for developer execution.");
  }
  // Missing local settings fail before claiming work.
  const dependencies = createWorkerAdapters(process.env, configuration.corpus);
  const claimed = await invoke<Claim>("collection:claimJob", { jobId }, true);
  if (!claimed) return { jobId, claimed: false, status: await invoke<Status>("collection:getStatus", { jobId }) };
  const { request, attempt } = claimed;
  try {
    if (claimed.stagingBackend !== "s3") fail("This capture is pinned to Convex storage. Resume it with convex execution.");
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

async function doctor(selectedRuntime?: WorkerRuntime): Promise<unknown> {
  const configuration = await invoke<Configuration>("collection:getConfiguration", {});
  if (configuration.stagingBackend === "convex") {
    return {
      deployment: target(),
      worker: selectedRuntime ?? configuration.workerMode,
      stagingBackend: "convex",
      configuration: configuration.configuration,
      nativeStorageWriteVerified: false,
      nextStep: "Collect an approved source, then use storage inspect --job <job-id> to verify its retained bytes.",
      ...((selectedRuntime ?? configuration.workerMode) === "developer"
        ? { executionIssue: "Native Convex storage requires convex execution." } : {}),
    };
  }
  if ((selectedRuntime ?? configuration.workerMode) === "convex") {
    return { deployment: target(), ...(await invoke<Record<string, unknown>>("acquisition:probeMinio", {})), minioAuthenticatedAccess: false };
  }
  const { staging } = createWorkerAdapters(process.env, configuration.corpus);
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
      runtime: { type: "string" },
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
    case "runtime":
      if (positionals[1] !== "set" || !positionals[2] || positionals.length !== 3) fail("Use runtime set developer or runtime set convex.");
      result = await cli(["env", "set", "COLLECTION_EXECUTION_MODE", runtime(positionals[2])], true);
      break;
    case "storage":
      if (positionals[1] === "set" && positionals[2] && positionals.length === 3) {
        result = await cli(["env", "set", "COLLECTION_STAGING_BACKEND", stagingBackend(positionals[2])], true);
      } else if (positionals[1] === "inspect" && positionals.length === 2 && values.job) {
        result = await invoke("acquisition:inspectStaging", { jobId: values.job }, false, 9 * 60_000);
      } else {
        fail("Use storage set convex, storage set s3, or storage inspect --job <job-id>.");
      }
      break;
    case "worker":
      if (!values.job) fail("Worker requires --job.");
      result = await worker(values.job, values.runtime === undefined ? undefined : runtime(values.runtime));
      break;
    case "doctor":
      result = await doctor(values.runtime === undefined ? undefined : runtime(values.runtime));
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
