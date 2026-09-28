import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { normalizeCorpus } from "./normalization-io.js";

try {
  const { values } = parseArgs({ options: {
    corpus: { type: "string" },
    "processor-revision": { type: "string" },
    "input-revision": { type: "string" },
    capture: { type: "string", multiple: true },
    all: { type: "boolean" },
    summary: { type: "string" },
  } });
  if (!values.corpus || !values["processor-revision"] || !values["input-revision"] || Boolean(values.all) === Boolean(values.capture?.length)) {
    throw new Error("Usage: pnpm normalize --corpus <checkout> --processor-revision <40hex> --input-revision <40hex> (--capture <id> | --all) [--summary <new-file>]");
  }
  const execute = promisify(execFile);
  const toolingRoot = fileURLToPath(new URL("../", import.meta.url));
  const revision = await execute("git", ["rev-parse", "HEAD"], { cwd: toolingRoot });
  const dirty = await execute("git", ["status", "--porcelain", "--untracked-files=normal", "--", "packages", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"], { cwd: toolingRoot });
  if (revision.stdout.trim() !== values["processor-revision"] || dirty.stdout.trim()) throw new Error("Run a clean checkout at the declared processor revision.");
  const outcomes = await normalizeCorpus({
    corpusPath: values.corpus,
    processorRevision: values["processor-revision"],
    inputCommitSha: values["input-revision"],
    ...(values.capture ? { captureIds: values.capture } : {}),
  });
  const output = `${JSON.stringify({ schemaVersion: 1, outcomes }, null, 2)}\n`;
  if (values.summary) await writeFile(values.summary, output, { flag: "wx" });
  process.stdout.write(output);
  if (outcomes.some((item) => item.status === "failed")) process.exitCode = 1;
} catch (error) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "NORMALIZATION_COMMAND_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
