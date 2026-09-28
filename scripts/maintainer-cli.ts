import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CollectionError } from "@bmw-knowledge/collection/policy";
import { parseConvexOutput } from "./cli-output.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);

export function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile(resolve(root, ".env.local"));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

function fail(message: string): never {
  throw new CollectionError("DEVELOPER_CONFIGURATION", message);
}

export function personalDevTarget(): string {
  if (process.env.CONVEX_DEPLOY_KEY || process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    fail("This developer command uses the signed-in CLI. Remove deployment-key overrides before selecting personal dev.");
  }
  const deployment = process.env.CONVEX_DEPLOYMENT?.match(/^dev:([a-z0-9-]+)$/)?.[1];
  if (!deployment) fail("CONVEX_DEPLOYMENT must select an existing personal dev deployment in .env.local.");
  return deployment;
}

/** Native CLI login needs no worker or application MCP credentials. */
export function nativeCliEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith("S3_") || ["CORPUS_GITHUB_TOKEN", "PROCESSING_CALLBACK_SECRET", "RESEARCH_MCP_SECRET"].includes(key)) delete result[key];
  }
  return result;
}

export async function devCli(args: string[], mutating = false): Promise<string> {
  const deployment = personalDevTarget();
  if (mutating) console.error(`target: dev (${deployment}, maintainer developer command)`);
  try {
    const result = await execute("pnpm", ["exec", "convex", ...args, "--deployment", deployment], {
      cwd: root,
      env: nativeCliEnvironment(process.env),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
    });
    return result.stdout.trim();
  } catch {
    fail(`Convex command ${args[0]} ${args[1] ?? ""} failed. Inspect the selected dev deployment's logs.`);
  }
}

export async function invokeDevFunction<T>(name: string, args: Record<string, unknown>, mutating = false): Promise<T> {
  const output = await devCli(["run", name, JSON.stringify(args)], mutating);
  try {
    return parseConvexOutput(output) as T;
  } catch {
    fail(`Convex function ${name} returned an unexpected CLI result.`);
  }
}
