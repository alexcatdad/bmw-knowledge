import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isResearchToolName,
  MAX_MCP_REQUEST_BYTES,
  parseResearchToolInput,
  parseResearchToolOutput,
  RESEARCH_TOOL_NAMES,
  type ResearchToolName,
} from "@bmw-knowledge/mcp/contract";
import { invokeDevFunction, loadLocalEnvironment, personalDevTarget } from "./maintainer-cli.js";

loadLocalEnvironment();

const operations: Record<ResearchToolName, { functionName: string; mutating: boolean }> = {
  get_research_brief: { functionName: "research:getBrief", mutating: false },
  begin_research_run: { functionName: "research:beginRun", mutating: true },
  search_sources: { functionName: "research:searchSources", mutating: false },
  submit_discoveries: { functionName: "research:submitDiscoveries", mutating: true },
  get_collection_status: { functionName: "research:getCollectionStatus", mutating: false },
  finish_research_run: { functionName: "research:finishRun", mutating: true },
  save_research_report: { functionName: "research:saveReport", mutating: true },
  get_research_report: { functionName: "research:getReport", mutating: false },
};

const help = `Research imports and reads (personal Convex dev only):
  pnpm research config
  pnpm research get_research_brief
  pnpm research <tool-name> --input <absolute-json-file>

Fixed tool names:
  ${RESEARCH_TOOL_NAMES.join("\n  ")}

Keep keys and exact payloads when replaying an uncertain write. Manual reports
are cited research interpretations, stored separately from captured evidence.
This command uses native CLI login; it does not require the MCP credential.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: "boolean", short: "h" }, input: { type: "string" },
  } });
  const command = positionals[0];
  if (values.help || !command || command === "help") { process.stdout.write(help); return; }
  if (positionals.length !== 1) throw new Error("Use one fixed tool name and --input <json-file>.");
  if (command === "config") {
    if (values.input) throw new Error("Configuration reads accept no input file.");
    const configuration = await invokeDevFunction("research:getConfiguration", {});
    console.log(JSON.stringify({ deployment: personalDevTarget(), configuration }, null, 2));
    return;
  }
  if (!isResearchToolName(command)) throw new Error("Unknown research tool. Use pnpm research --help.");
  let input: unknown = {};
  if (values.input) {
    const path = resolve(process.cwd(), values.input);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_MCP_REQUEST_BYTES) throw new Error("Research input must be a bounded regular JSON file.");
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_MCP_REQUEST_BYTES) throw new Error("Research input exceeds the request size limit.");
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } else if (command !== "get_research_brief") {
    throw new Error("This research tool requires --input <json-file>.");
  }
  const arguments_ = parseResearchToolInput(command, input);
  const operation = operations[command];
  const result = await invokeDevFunction(operation.functionName, arguments_, operation.mutating);
  console.log(JSON.stringify(parseResearchToolOutput(command, result), null, 2));
}

await main().catch(() => {
  // Input files and native CLI exceptions can contain sensitive report text.
  console.error("Research command failed. Check the fixed tool name, input contract, and selected dev deployment's logs.");
  process.exitCode = 1;
});
