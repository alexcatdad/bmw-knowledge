import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createResearchMcpHandler } from "../src/index.js";
import { MAX_MCP_REQUEST_BYTES, MAX_MCP_RESULT_BYTES, RESEARCH_TOOL_NAMES, RESEARCH_TOOL_ERROR_MESSAGES, ResearchToolError } from "../src/contract.js";
import type { ResearchToolArguments } from "../src/contract.js";
import { AUTHORIZATION, brief, discoveryInput, ENDPOINT, fixtureBackend, postRpc, reportInput, runInput, sdkClient, toolErrorBody } from "./helpers.js";

afterEach(() => { vi.useRealTimers(); });

function authenticated(request: Request): boolean {
  return request.headers.get("authorization") === AUTHORIZATION;
}

describe("official SDK over stateless research HTTP", () => {
  it("initializes, lists all fixed tool annotations, reads context, writes and reads a native cited report", async () => {
    const backend = fixtureBackend();
    const authenticate = vi.fn(authenticated);
    const handler = createResearchMcpHandler({ authenticate, invoke: backend.invoke });
    const { client, transport, requests, responses } = await sdkClient(handler);
    try {
      expect(client.getServerVersion()).toEqual({ name: "bmw-knowledge-research", version: "0.1.0" });
      expect(client.getInstructions()).toContain("do not extract automotive facts");
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...RESEARCH_TOOL_NAMES]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.annotations?.destructiveHint).toBe(false);
        expect(tool.annotations?.idempotentHint).toBe(true);
        expect(tool.annotations?.openWorldHint).toBe(tool.name === "submit_discoveries");
        expect(tool.annotations?.readOnlyHint).toBe(["get_research_brief", "search_sources", "get_collection_status", "get_research_report"].includes(tool.name));
      }

      const context = await client.callTool({ name: "get_research_brief", arguments: {} });
      expect(context.structuredContent).toEqual(brief());
      expect(backend.invoke.mock.calls.map(([name]) => name)).toEqual(["get_research_brief"]);
      const begun = await client.callTool({ name: "begin_research_run", arguments: runInput });
      expect(begun.structuredContent).toEqual({ runId: "run-1", brief: brief() });
      const batch = await client.callTool({ name: "submit_discoveries", arguments: discoveryInput });
      expect(batch.structuredContent).toMatchObject({ batchId: "batch-1", results: [{ discoveryId: "discovery-1", sourceId: "source-1", jobId: null, status: "deferred" }] });
      const searched = await client.callTool({ name: "search_sources", arguments: { domain: "example.org" } });
      expect(searched.structuredContent).toMatchObject({ sources: [{ sourceId: "source-1", acquisitionEligibility: "reference_only" }] });
      expect(backend.invoke.mock.calls.find(([name]) => name === "search_sources")?.[1]).toEqual({ domain: "example.org", limit: 10 });
      const status = await client.callTool({ name: "get_collection_status", arguments: { sourceIds: ["source-1"] } });
      expect(status.structuredContent).toMatchObject({ sources: [{ capture: null, job: null, processing: [] }] });
      const saved = await client.callTool({ name: "save_research_report", arguments: reportInput });
      expect(saved.isError).not.toBe(true);
      expect(saved.structuredContent).toEqual({ reportId: "report-1", kind: "manual_research_report", verification: "unverified_research" });
      const stored = await client.callTool({ name: "get_research_report", arguments: { reportId: "report-1" } });
      expect(stored.structuredContent).toMatchObject({ report: { markdown: reportInput.markdown, citations: reportInput.citations, verification: "unverified_research" } });
      const finishInput: ResearchToolArguments<"finish_research_run"> = { runId: "run-1", outcome: "Fixture complete.", unresolvedLeads: [{ url: "https://example.org/next", note: "Synthetic next lead." }], nextDirections: ["Test connected client separately."] };
      expect((await client.callTool({ name: "finish_research_run", arguments: finishInput })).structuredContent).toEqual({ runId: "run-1", status: "finished" });
      expect(transport.sessionId).toBeUndefined();
      expect(responses.every((response) => response.headers.get("mcp-session-id") === null)).toBe(true);
      expect(authenticate).toHaveBeenCalledTimes(requests.length);
    } finally { await client.close(); }
  });

  it("rejects unknown/admin tool names and strict invalid write arguments without dispatch", async () => {
    const backend = fixtureBackend();
    const { client } = await sdkClient(createResearchMcpHandler({ authenticate: authenticated, invoke: backend.invoke }));
    try {
      await client.listTools();
      await expect(client.callTool({ name: "set_source_approval", arguments: { origin: "https://example.org/" } })).rejects.toMatchObject({ code: -32601 });
      await expect(client.callTool({ name: "submit_discoveries", arguments: { ...discoveryInput, approved: true } })).rejects.toMatchObject({ code: -32602 });
      await expect(client.callTool({ name: "submit_discoveries", arguments: { ...discoveryInput, discoveries: [{ ...discoveryInput.discoveries[0], url: "https://user:password@example.org/" }] } })).rejects.toMatchObject({ code: -32602 });
      expect(backend.invoke).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it("returns typed fixed backend failures and withholds unexpected errors and invalid outputs", async () => {
    const marker = "PRIVATE_UPSTREAM_DETAILS";
    const conflict = new ResearchToolError("IDEMPOTENCY_CONFLICT");
    conflict.message = marker;
    const invoke = vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(new Error(marker)).mockResolvedValueOnce({ reportId: "report-1", kind: "manual_research_report", verification: "verified_fact", providerBody: marker });
    const { client } = await sdkClient(createResearchMcpHandler({ authenticate: authenticated, invoke }));
    try {
      await client.listTools();
      const typed = await client.callTool({ name: "begin_research_run", arguments: runInput });
      expect(toolErrorBody(typed)).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT", message: RESEARCH_TOOL_ERROR_MESSAGES.IDEMPOTENCY_CONFLICT } });
      const unknown = await client.callTool({ name: "get_research_brief", arguments: {} });
      expect(toolErrorBody(unknown)).toEqual({ error: { code: "TOOL_FAILED", message: RESEARCH_TOOL_ERROR_MESSAGES.TOOL_FAILED } });
      const invalid = await client.callTool({ name: "save_research_report", arguments: reportInput });
      expect(toolErrorBody(invalid)).toEqual({ error: { code: "TOOL_FAILED", message: RESEARCH_TOOL_ERROR_MESSAGES.TOOL_FAILED } });
      for (const result of [typed, unknown, invalid]) expect(JSON.stringify(result)).not.toContain(marker);
    } finally { await client.close(); }
  });

  it("returns isError for a changed-payload batch conflict after initialize and tools/list cached its success schema", async () => {
    const acceptedBatch = { batchId: "batch-1", results: [{ discoveryId: "discovery-1", sourceId: "source-1", jobId: null, status: "deferred", reason: "Maintainer acquisition approval is required." }] };
    const invoke = vi.fn().mockResolvedValueOnce(acceptedBatch).mockRejectedValueOnce(new ResearchToolError("IDEMPOTENCY_CONFLICT"));
    const { client } = await sdkClient(createResearchMcpHandler({ authenticate: authenticated, invoke }));
    try {
      const listed = await client.listTools();
      expect(listed.tools.find((tool) => tool.name === "submit_discoveries")?.outputSchema).toHaveProperty("required", ["batchId", "results"]);
      const original = await client.callTool({ name: "submit_discoveries", arguments: discoveryInput });
      expect(original.isError).not.toBe(true);
      expect(original.structuredContent).toEqual(acceptedBatch);
      const changed: ResearchToolArguments<"submit_discoveries"> = { ...discoveryInput, discoveries: [{ ...discoveryInput.discoveries[0]!, relevance: "Changed payload under the same idempotency key." }] };
      const conflict = await client.callTool({ name: "submit_discoveries", arguments: changed });
      expect(toolErrorBody(conflict)).toEqual({ error: { code: "IDEMPOTENCY_CONFLICT", message: RESEARCH_TOOL_ERROR_MESSAGES.IDEMPOTENCY_CONFLICT } });
      expect(invoke).toHaveBeenNthCalledWith(2, "submit_discoveries", changed);
    } finally { await client.close(); }
  });

  it("closes each per-request server and transport, including SDK transport rejection", async () => {
    const closeServer = vi.spyOn(McpServer.prototype, "close");
    const closeTransport = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "close");
    const handler = createResearchMcpHandler({ authenticate: authenticated, invoke: fixtureBackend().invoke });
    const responses = await Promise.all([
      handler(postRpc("tools/list", {}, {}, 7)),
      handler(postRpc("tools/list", {}, {}, 7)),
      handler(postRpc("tools/list", {}, { accept: "application/json" }, 7)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 406]);
    expect(closeServer).toHaveBeenCalledTimes(3);
    expect(closeTransport).toHaveBeenCalledTimes(3);
    expect((await responses[0]?.json() as { id: number }).id).toBe(7);
    expect((await responses[1]?.json() as { id: number }).id).toBe(7);
  });
});

describe("authentication and request boundaries", () => {
  it("authenticates every method before body parsing or operations and fails closed on host errors", async () => {
    const authenticate = vi.fn(() => false);
    const invoke = vi.fn();
    const handler = createResearchMcpHandler({ authenticate, invoke });
    const request = new Request(ENDPOINT, { method: "POST", body: "not JSON" });
    const read = vi.spyOn(request.body!, "getReader");
    expect((await handler(request)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    for (const method of ["GET", "DELETE", "OPTIONS", "HEAD"]) expect((await handler(new Request(ENDPOINT, { method }))).status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(5);
    expect(invoke).not.toHaveBeenCalled();
    const failed = createResearchMcpHandler({ authenticate: () => { throw new Error("PRIVATE_AUTH_DETAILS"); }, invoke });
    const response = await failed(postRpc("get_research_brief"));
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("PRIVATE_AUTH_DETAILS");
  });

  it("denies browser origins by default and allows only explicitly configured exact origins", async () => {
    const backend = fixtureBackend();
    const denied = createResearchMcpHandler({ authenticate: authenticated, invoke: backend.invoke });
    expect((await denied(postRpc("tools/call", { name: "begin_research_run", arguments: runInput }, { origin: "https://chat.example.org" }))).status).toBe(403);
    const allowed = createResearchMcpHandler({ authenticate: authenticated, invoke: backend.invoke, allowedOrigins: ["https://chat.example.org"] });
    expect((await allowed(postRpc("tools/call", { name: "get_research_brief", arguments: {} }, { origin: "https://chat.example.org" }))).status).toBe(200);
    expect((await allowed(postRpc("tools/list", {}, { origin: "https://chat.example.org.attacker.com" }))).status).toBe(403);
    expect((await allowed(postRpc("tools/list", {}, { origin: "null" }))).status).toBe(403);
    expect(backend.invoke.mock.calls.map(([name]) => name)).toEqual(["get_research_brief"]);
    expect(() => createResearchMcpHandler({ authenticate: authenticated, invoke: backend.invoke, allowedOrigins: ["https://chat.example.org/path"] })).toThrow(ResearchToolError);
  });

  it("returns 405 for authorized GET/DELETE, rejects unsupported content and lets SDK enforce Accept", async () => {
    const invoke = fixtureBackend().invoke;
    const handler = createResearchMcpHandler({ authenticate: authenticated, invoke });
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const response = await handler(new Request(ENDPOINT, { method, headers: { authorization: AUTHORIZATION } }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    expect((await handler(postRpc("tools/list", {}, { "content-type": "text/plain" }))).status).toBe(415);
    expect((await handler(postRpc("tools/list", {}, { "content-encoding": "gzip" }))).status).toBe(415);
    expect((await handler(postRpc("tools/list", {}, { accept: "application/json" }))).status).toBe(406);
    const unsupportedProtocol = await handler(postRpc("tools/list", {}, { "mcp-protocol-version": "PRIVATE_PROTOCOL_DETAILS" }));
    expect(unsupportedProtocol.status).toBe(400);
    expect(await unsupportedProtocol.text()).not.toContain("PRIVATE_PROTOCOL_DETAILS");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects declared and streamed oversized bodies before any operation", async () => {
    const invoke = fixtureBackend().invoke;
    const handler = createResearchMcpHandler({ authenticate: authenticated, invoke });
    const declared = postRpc("tools/call", { name: "begin_research_run", arguments: runInput }, { "content-length": String(MAX_MCP_REQUEST_BYTES + 1) });
    const read = vi.spyOn(declared.body!, "getReader");
    expect((await handler(declared)).status).toBe(413);
    expect(read).not.toHaveBeenCalled();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_MCP_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
      }, cancel,
    });
    const requestOptions: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: AUTHORIZATION, "content-type": "application/json" }, body: stream, duplex: "half" };
    const streamed = await handler(new Request(ENDPOINT, requestOptions));
    expect(streamed.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("times out an unfinished body stream without awaiting hostile cancellation", async () => {
    vi.useFakeTimers();
    const invoke = fixtureBackend().invoke;
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const requestOptions: RequestInit & { duplex: "half" } = { method: "POST", headers: { authorization: AUTHORIZATION, "content-type": "application/json" }, body: stream, duplex: "half" };
    const pending = createResearchMcpHandler({ authenticate: authenticated, invoke })(new Request(ENDPOINT, requestOptions));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).status).toBe(408);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects JSON batches before their first write and never echoes malformed or administrative payloads", async () => {
    const invoke = fixtureBackend().invoke;
    const handler = createResearchMcpHandler({ authenticate: authenticated, invoke });
    const headers = { authorization: AUTHORIZATION, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "begin_research_run", arguments: runInput } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "submit_discoveries", arguments: discoveryInput } },
    ];
    expect((await handler(new Request(ENDPOINT, { method: "POST", headers, body: JSON.stringify(batch) }))).status).toBe(400);
    const marker = "PRIVATE_MALFORMED_DETAILS";
    for (const body of [`{"broken":"${marker}",`, JSON.stringify({ jsonrpc: "2.0", id: 1, method: `admin/${marker}`, params: {} }), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_research_brief", arguments: {}, task: { secret: marker } } }), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "begin_research_run", arguments: { ...runInput, origin: marker } } })]) {
      const response = await handler(new Request(ENDPOINT, { method: "POST", headers, body }));
      const output = await response.text();
      expect(output).toContain("error");
      expect(output).not.toContain(marker);
    }
    const invalidUtf8 = await handler(new Request(ENDPOINT, { method: "POST", headers, body: new Uint8Array([0xc3, 0x28]) }));
    expect(invalidUtf8.status).toBe(400);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("bounds valid but excessively extended backend results without leaking their content", async () => {
    const invoke = vi.fn(async () => ({ ...brief(), extra: "x".repeat(MAX_MCP_RESULT_BYTES) }));
    const response = await createResearchMcpHandler({ authenticate: authenticated, invoke })(postRpc("tools/call", { name: "get_research_brief", arguments: {} }));
    expect(response.status).toBe(200);
    const payload = await response.json() as { result: CallToolResult };
    expect(toolErrorBody(payload.result)).toEqual({ error: { code: "TOOL_FAILED", message: RESEARCH_TOOL_ERROR_MESSAGES.TOOL_FAILED } });
  });
});
