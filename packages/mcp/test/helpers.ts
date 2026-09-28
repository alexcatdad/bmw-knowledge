import { expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESEARCH_INSTRUCTION_TEXT, RESEARCH_INSTRUCTION_VERSION, parseResearchToolInput } from "../src/contract.js";
import type { ResearchToolArguments, ResearchToolName, ResearchToolResult } from "../src/contract.js";

export const ENDPOINT = "https://kb.example.com/mcp";
export const AUTHORIZATION = "Bearer dedicated-test-credential";

export function toolErrorBody(result: unknown): unknown {
  const failure = CallToolResultSchema.parse(result);
  expect(failure.isError).toBe(true);
  expect(result).not.toHaveProperty("structuredContent");
  expect(failure.content).toHaveLength(1);
  const content = failure.content[0];
  if (content?.type !== "text") throw new Error("Expected one fixed text error envelope.");
  return JSON.parse(content.text) as unknown;
}

export function brief(): ResearchToolResult<"get_research_brief"> {
  return {
    scope: { series: ["E30", "E46"], focus: [], bodyStyles: [], operationalLanguage: "en" },
    instructionVersion: RESEARCH_INSTRUCTION_VERSION,
    instruction: RESEARCH_INSTRUCTION_TEXT,
    approvals: { count: 0, rules: [], truncated: false },
    recentSources: [], recentRuns: [], recentReports: [],
  };
}

export const runInput: ResearchToolArguments<"begin_research_run"> = {
  idempotencyKey: "fixture-run-1", client: "official-sdk-test", mode: "manual_deep_research", objective: "Synthetic research record test; no automotive claims.",
};

export const discoveryInput: ResearchToolArguments<"submit_discoveries"> = {
  runId: "run-1", idempotencyKey: "fixture-batch-1",
  discoveries: [{ url: "https://example.org/source", title: "Synthetic source", relevance: "Fixture lead; no BMW evidence.", series: ["E30"], topics: ["fixture"], language: "en", referrerUrl: "https://example.org/" }],
};

export const reportInput: ResearchToolArguments<"save_research_report"> = {
  runId: "run-1", idempotencyKey: "fixture-report-1", title: "Fixture report", summary: "Synthetic cited report storage test.",
  markdown: "# Fixture\n\nCited unverified research, with original language: șurub, Rücklicht.\n\n[Source](https://example.org/source)\n",
  series: ["E30", "E46"], topics: ["fixture"], citations: [{ url: "https://example.org/source", title: "Synthetic source", note: "No automotive evidence." }],
};

export function fixtureBackend() {
  let savedReport: Record<string, unknown> | null = null;
  const source = { sourceId: "source-1", url: "https://example.org/source", acquisitionEligibility: "reference_only" as const };
  const invoke = vi.fn(async (name: ResearchToolName, args: ResearchToolArguments): Promise<Record<string, unknown>> => {
    switch (name) {
      case "get_research_brief": return brief();
      case "begin_research_run": return { runId: "run-1", brief: brief() };
      case "search_sources": return { sources: [source], legacyMetadataNotIndexed: false };
      case "submit_discoveries": return { batchId: "batch-1", results: [{ discoveryId: "discovery-1", sourceId: source.sourceId, jobId: null, status: "deferred", reason: "Maintainer acquisition approval is required." }] };
      case "get_collection_status": {
        const input = parseResearchToolInput("get_collection_status", args);
        return { sources: input.sourceIds.map((sourceId) => ({ sourceId, exists: sourceId === source.sourceId, source: sourceId === source.sourceId ? source : null, job: null, capture: null, processing: [] })) };
      }
      case "finish_research_run": return { runId: "run-1", status: "finished" };
      case "save_research_report": {
        const input = parseResearchToolInput("save_research_report", args);
        savedReport = { ...input, reportId: "report-1", kind: "manual_research_report", verification: "unverified_research", createdAt: 0 };
        return { reportId: "report-1", kind: "manual_research_report", verification: "unverified_research" };
      }
      case "get_research_report": return { report: savedReport };
    }
  });
  return { invoke };
}

export function postRpc(method: string, params: unknown = {}, headers: HeadersInit = {}, id: string | number = 1): Request {
  const merged = new Headers({ authorization: AUTHORIZATION, accept: "application/json, text/event-stream", "content-type": "application/json" });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Request(ENDPOINT, { method: "POST", headers: merged, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

export async function sdkClient(handler: (request: Request) => Promise<Response>) {
  const requests: Request[] = [];
  const responses: Response[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    const response = await handler(request);
    responses.push(response);
    return response;
  };
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit: { headers: { authorization: AUTHORIZATION } }, fetch });
  const client = new Client({ name: "official-sdk-handler-test", version: "0.1.0" });
  // SDK 1.30.1 declares a string|undefined sessionId getter against its own
  // optional Transport property. Keep exactOptionalPropertyTypes and bridge
  // that declaration mismatch only at this documented SDK connect boundary.
  await client.connect(transport as Transport);
  return { client, transport, requests, responses };
}
