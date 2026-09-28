import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  parseResearchToolInput,
  parseResearchToolOutput,
  RESEARCH_TOOL_NAMES,
  type ResearchToolArguments,
  type ResearchToolName,
  type ResearchToolResult,
  type ResearchToolErrorCode,
} from "@bmw-knowledge/mcp/contract";
import { loadLocalEnvironment, personalDevTarget } from "./maintainer-cli.js";

loadLocalEnvironment();
let stage = "developer configuration";

async function main(): Promise<void> {
  const deployment = personalDevTarget();
  const site = process.env.CONVEX_SITE_URL ?? `https://${deployment}.convex.site`;
  if (site !== `https://${deployment}.convex.site`) throw new Error("The MCP smoke target must match the existing personal development deployment.");
  const secret = process.env.RESEARCH_MCP_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new Error("A dedicated developer MCP credential is required.");
  const endpoint = new URL("/mcp", site);
  const client = new Client({ name: "bmw-kb-development-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    fetch: async (input, init) => fetch(input, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    }),
  });

  async function call<Name extends ResearchToolName>(name: Name, input: ResearchToolArguments<Name>): Promise<ResearchToolResult<Name>> {
    const result = await client.callTool({ name, arguments: parseResearchToolInput(name, input) });
    assert.notEqual(result.isError, true, "The intended research operation must succeed.");
    return parseResearchToolOutput(name, result.structuredContent);
  }
  async function rejected(name: ResearchToolName, input: unknown, code: ResearchToolErrorCode): Promise<void> {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: input as Record<string, unknown> }));
    assert.equal(result.isError, true, "A conflicting or closed-run write must be rejected.");
    assert.equal(result.structuredContent, undefined);
    const text = result.content[0];
    assert(text?.type === "text");
    assert.equal(JSON.parse(text.text).error.code, code);
  }

  try {
    // SDK 1.30.1's getter explicitly includes undefined while its Transport
    // interface declares an optional property. Bridge that SDK declaration
    // mismatch without relaxing this project's exact optional field checks.
    stage = "SDK initialization";
    await client.connect(transport as Transport);
    stage = "tool discovery";
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...RESEARCH_TOOL_NAMES].sort());
    for (const tool of listed.tools) assert.equal(tool.annotations?.destructiveHint, false);
    stage = "research brief";
    const brief = await call("get_research_brief", {});
    // This smoke deliberately creates reference-only fixtures. Stop before any
    // persistent write if the dev deployment has an acquisition policy.
    assert.equal(brief.approvals.count, 0, "Use a dev deployment with no acquisition approvals for this fixture smoke.");
    // convex-test cannot model full-text search over an absent optional field.
    // Exercise the real platform before this smoke adds an indexed fixture.
    stage = "legacy full-text lookup";
    const legacyLookup = await call("search_sources", { query: "mcp-integration-fixture", limit: 20 });
    const key = `mcp-fixture-${randomUUID()}`;
    const runInput = { idempotencyKey: key, client: "official-sdk-integration-fixture", mode: "manual_deep_research" as const, objective: "INTEGRATION FIXTURE: test research record transport; no automotive claims or real source capture." };
    stage = "concurrent run replay";
    const [begun, replayedRun] = await Promise.all([
      call("begin_research_run", runInput), call("begin_research_run", runInput),
    ]);
    assert.equal(replayedRun.runId, begun.runId);
    const sourceUrl = `https://example.org/${key}`;
    const batchInput = {
      runId: begun.runId, idempotencyKey: "fixture-batch-1",
      discoveries: [{ url: sourceUrl, title: "INTEGRATION FIXTURE — source metadata only", relevance: "Synthetic reference-only discovery; no BMW evidence.", series: ["E30" as const], topics: ["mcp-integration-fixture"], language: "en", bodyStyles: ["sedan"], referrerUrl: "https://example.org/" }],
    };
    stage = "discovery batch replay";
    const [batch, concurrentBatch] = await Promise.all([
      call("submit_discoveries", batchInput), call("submit_discoveries", batchInput),
    ]);
    assert.deepEqual(concurrentBatch, batch);
    assert.deepEqual(await call("submit_discoveries", batchInput), batch);
    const item = batch.results[0];
    assert(item);
    assert.equal(item.status, "deferred");
    assert.equal(item.jobId, null);
    await rejected("submit_discoveries", { ...batchInput, discoveries: [{ ...batchInput.discoveries[0], relevance: "Changed fixture data under the same key." }] }, "IDEMPOTENCY_CONFLICT");
    stage = "source lookups";
    const lookup = await call("search_sources", { url: sourceUrl, limit: 10 });
    assert.equal(lookup.sources.length, 1);
    assert.equal(lookup.sources[0]?.sourceId, item.sourceId);
    const domainLookup = await call("search_sources", { domain: "example.org", limit: 20 });
    assert(domainLookup.sources.some((source) => source.sourceId === item.sourceId));
    const topicLookup = await call("search_sources", { query: "mcp-integration-fixture", limit: 20 });
    assert(topicLookup.sources.some((source) => source.sourceId === item.sourceId));
    stage = "collection status";
    const status = await call("get_collection_status", { sourceIds: [item.sourceId] });
    assert.equal(status.sources[0]?.exists, true);
    assert.equal(status.sources[0]?.job, null);
    assert.equal(status.sources[0]?.capture, null);
    assert.deepEqual(status.sources[0]?.processing, []);
    const reportInput = {
      runId: begun.runId, idempotencyKey: "fixture-report-1",
      title: "INTEGRATION FIXTURE — manual report transport",
      summary: "Tests cited Markdown storage and replay. Contains no automotive findings.",
      markdown: "# Integration fixture\n\nThis synthetic report verifies KB storage only. It contains no BMW evidence.\n\n[Project-owned fixture](https://github.com/alexcatdad/bmw-knowledge/blob/d06a036caade7155a81a546ae3976a36ed8c5a76/fixtures/http-source.html)\n",
      series: ["E30" as const], topics: ["mcp-integration-fixture"],
      citations: [{ url: "https://github.com/alexcatdad/bmw-knowledge/blob/d06a036caade7155a81a546ae3976a36ed8c5a76/fixtures/http-source.html", title: "Project-owned fixture; no automotive evidence" }],
    };
    stage = "manual report replay";
    const [report, concurrentReport] = await Promise.all([
      call("save_research_report", reportInput), call("save_research_report", reportInput),
    ]);
    assert.equal(concurrentReport.reportId, report.reportId);
    assert.equal(report.kind, "manual_research_report");
    assert.equal(report.verification, "unverified_research");
    assert.equal((await call("save_research_report", reportInput)).reportId, report.reportId);
    await rejected("save_research_report", { ...reportInput, summary: "Changed fixture summary under the same key." }, "IDEMPOTENCY_CONFLICT");
    const stored = await call("get_research_report", { reportId: report.reportId });
    assert.equal(stored.report?.markdown, reportInput.markdown);
    assert.deepEqual(stored.report?.citations, reportInput.citations);
    stage = "closed-run replay";
    const finishInput = { runId: begun.runId, outcome: "INTEGRATION FIXTURE complete: real SDK transport stored/replayed a reference and cited report; no capture or publication occurred.", unresolvedLeads: [], nextDirections: ["Demonstrate OAuth with the owner's actual ChatGPT connection."] };
    assert.deepEqual(await call("finish_research_run", finishInput), await call("finish_research_run", finishInput));
    assert.deepEqual(await call("submit_discoveries", batchInput), batch);
    assert.equal((await call("save_research_report", reportInput)).reportId, report.reportId);
    await rejected("submit_discoveries", { ...batchInput, idempotencyKey: "new-write-after-finish" }, "RUN_FINISHED");
    await rejected("save_research_report", { ...reportInput, idempotencyKey: "new-report-after-finish" }, "RUN_FINISHED");
    console.log(JSON.stringify({
      deployment, transport: "remote-convex-streamable-http", client: "official-mcp-typescript-sdk",
      runId: begun.runId, batchId: batch.batchId, sourceId: item.sourceId, reportId: report.reportId,
      toolsVerified: listed.tools.length, replayAndConflictsVerified: true, concurrentReplayVerified: true,
      legacyMetadataSearchVerified: legacyLookup.legacyMetadataNotIndexed,
      fixture: true, liveAcquisition: false, chatGptConnectionVerified: false,
    }, null, 2));
  } finally {
    await client.close();
  }
}

await main().catch(() => {
  console.error(`Remote MCP smoke failed during ${stage}. Inspect the selected dev deployment and fixed tool contracts; credential and provider errors are withheld.`);
  process.exitCode = 1;
});
