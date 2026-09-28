import { lstat, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { processingManifestSchema } from "@bmw-knowledge/normalization/contract";
import { reportNormalization, type NormalizationOutcome } from "./normalization-io.js";

try {
  const { values } = parseArgs({ options: {
    corpus: { type: "string" }, summary: { type: "string" }, "result-revision": { type: "string" },
  } });
  if (!values.corpus || !values.summary || !values["result-revision"]) throw new Error("Missing command arguments.");
  const stat = await lstat(values.summary);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error("Invalid result summary.");
  const summary: unknown = JSON.parse(await readFile(values.summary, "utf8"));
  if (!summary || typeof summary !== "object" || !("schemaVersion" in summary) || summary.schemaVersion !== 1 || !("outcomes" in summary) || !Array.isArray(summary.outcomes) || summary.outcomes.length > 100) throw new Error("Invalid result summary.");
  const outcomes: NormalizationOutcome[] = summary.outcomes.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("status" in item)) throw new Error("Invalid result.");
    if (item.status === "succeeded" && "manifest" in item) return { status: "succeeded", manifest: processingManifestSchema.parse(item.manifest) };
    if (item.status !== "failed" || !("captureId" in item) || !("inputSha256" in item) || !("processorRevision" in item) || !("code" in item) || typeof item.captureId !== "string" || typeof item.inputSha256 !== "string" || typeof item.processorRevision !== "string" || typeof item.code !== "string") throw new Error("Invalid result.");
    return { status: "failed", captureId: item.captureId, inputSha256: item.inputSha256, processorRevision: item.processorRevision, code: item.code };
  });
  const reported = await reportNormalization({
    corpusPath: values.corpus,
    resultCommitSha: values["result-revision"],
    outcomes,
    callbackUrl: process.env.PROCESSING_CALLBACK_URL ?? "",
    secret: process.env.PROCESSING_CALLBACK_SECRET ?? "",
    owner: process.env.CORPUS_GITHUB_OWNER ?? "alexcatdad",
    repo: process.env.CORPUS_GITHUB_REPO ?? "bmw-corpus",
  });
  process.stdout.write(`${JSON.stringify({ reported })}\n`);
} catch {
  process.stderr.write("NORMALIZATION_REPORT_FAILED\n");
  process.exitCode = 1;
}
