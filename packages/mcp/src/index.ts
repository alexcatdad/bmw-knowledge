import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CancelledNotificationSchema,
  InitializedNotificationSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isBoundedText } from "@bmw-knowledge/collection/policy";
import {
  inputSchemas,
  isResearchToolName,
  MAX_MCP_REQUEST_BYTES,
  MAX_MCP_RESULT_BYTES,
  outputSchemas,
  parseResearchToolInput,
  parseResearchToolOutput,
  RESEARCH_INSTRUCTION_TEXT,
  RESEARCH_TOOL_ERROR_CODES,
  RESEARCH_TOOL_ERROR_MESSAGES,
  researchToolDefinitions,
  ResearchToolError,
} from "./contract.js";
import type { ResearchToolArguments, ResearchToolErrorCode, ResearchToolName } from "./contract.js";

export * from "./contract.js";

export interface ResearchMcpHandlerOptions {
  /** The host owns token validation. Missing configuration must return false. */
  authenticate(request: Request): boolean | Promise<boolean>;
  /** Dispatch only these fixed application operations; no dynamic function names. */
  invoke(name: ResearchToolName, args: ResearchToolArguments): Promise<Record<string, unknown>>;
  /** Browser requests with Origin are denied unless their exact origin is listed. */
  allowedOrigins?: readonly string[];
}

type RequestId = string | number;
interface RpcRequest {
  jsonrpc: "2.0";
  method: string;
  id?: RequestId;
  params?: Record<string, unknown>;
}

const REQUEST_BODY_TIMEOUT_MS = 15_000;
const responseHeaders = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const rpcMessages: Record<number, string> = {
  [-32700]: "Invalid JSON request.",
  [-32600]: "Invalid MCP request.",
  [-32601]: "MCP operation is not supported.",
  [-32602]: "Research tool arguments are invalid.",
  [-32603]: "The research request did not complete.",
  [-32000]: "MCP request is invalid or unsupported.",
};

function rpcError(status: number, code: number, id: RequestId | null = null, message = rpcMessages[code]): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { status, headers: responseHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

class RequestBodyError extends Error {
  constructor(readonly status: number, readonly messageCode: number, readonly safeMessage: string) {
    super(safeMessage);
  }
}

/** Count observed stream bytes as well as the declared length before parsing JSON. */
async function readJson(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new RequestBodyError(400, -32600, "Invalid MCP request.");
  }
  if (declared !== null && Number(declared) > MAX_MCP_REQUEST_BYTES) {
    throw new RequestBodyError(413, -32600, "Request body exceeds the allowed limit.");
  }
  if (request.body === null) throw new RequestBodyError(400, -32700, "Invalid JSON request.");

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestBodyError(408, -32600, "Request body was not received in time.")), REQUEST_BODY_TIMEOUT_MS);
  });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_MCP_REQUEST_BYTES) throw new RequestBodyError(413, -32600, "Request body exceeds the allowed limit.");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(400, -32700, "Invalid JSON request.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Cancellation must not keep the response waiting on a hostile body stream.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function requestId(value: unknown): RequestId | null {
  if (typeof value === "string" && isBoundedText(value, 128, true)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

/** Reject batches and response messages; this server never requests client operations. */
function parseRpc(value: unknown): RpcRequest | null {
  if (!isRecord(value) || !keysAre(value, ["jsonrpc", "method", "id", "params"]) || value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" || !isBoundedText(value.method, 100) ||
    (Object.hasOwn(value, "id") && requestId(value.id) === null) ||
    (Object.hasOwn(value, "params") && !isRecord(value.params))) return null;
  return value as unknown as RpcRequest;
}

function validateOperation(request: RpcRequest): RpcRequest | Response {
  const id = request.id ?? null;
  const params = request.params ?? {};
  switch (request.method) {
    case "tools/call": {
      if (id === null || !keysAre(params, ["name", "arguments", "_meta"]) ||
        (params._meta !== undefined && !isRecord(params._meta))) return rpcError(400, -32600, id);
      if (!isResearchToolName(params.name)) return rpcError(200, -32601, id);
      try {
        const args = parseResearchToolInput(params.name, params.arguments ?? {});
        return { ...request, params: { ...params, arguments: args } };
      } catch {
        return rpcError(200, -32602, id);
      }
    }
    case "tools/list":
      return id !== null && keysAre(params, ["cursor", "_meta"]) && ListToolsRequestSchema.safeParse(request).success
        ? request : rpcError(400, -32600, id);
    case "initialize":
      return id !== null && InitializeRequestSchema.safeParse(request).success ? request : rpcError(400, -32600, id);
    case "ping":
      return id !== null && keysAre(params, ["_meta"]) && PingRequestSchema.safeParse(request).success ? request : rpcError(400, -32600, id);
    case "notifications/initialized":
      return id === null && keysAre(params, ["_meta"]) && InitializedNotificationSchema.safeParse(request).success ? request : rpcError(400, -32600, id);
    case "notifications/cancelled":
      return id === null && keysAre(params, ["requestId", "reason", "_meta"]) && CancelledNotificationSchema.safeParse(request).success ? request : rpcError(400, -32600, id);
    default:
      return rpcError(200, -32601, id);
  }
}

function toolError(error: unknown): CallToolResult {
  const code: ResearchToolErrorCode = error instanceof ResearchToolError &&
    (RESEARCH_TOOL_ERROR_CODES as readonly string[]).includes(error.code) ? error.code : "TOOL_FAILED";
  const message = RESEARCH_TOOL_ERROR_MESSAGES[code];
  // SDK clients apply a cached success outputSchema to any structuredContent,
  // including error results. Keep the fixed failure envelope in text only.
  return { content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }], isError: true };
}

function createServer(invoke: ResearchMcpHandlerOptions["invoke"]): McpServer {
  const server = new McpServer({ name: "bmw-knowledge-research", version: "0.1.0" }, { instructions: RESEARCH_INSTRUCTION_TEXT });
  for (const definition of researchToolDefinitions) {
    const name = definition.name;
    server.registerTool(name, {
      title: definition.title,
      description: definition.description,
      inputSchema: inputSchemas[name],
      outputSchema: outputSchemas[name],
      annotations: definition.annotations,
    }, async (input: unknown): Promise<CallToolResult> => {
      try {
        const args = parseResearchToolInput(name, input);
        const output = parseResearchToolOutput(name, await invoke(name, args));
        const text = JSON.stringify(output);
        if (new TextEncoder().encode(text).byteLength > MAX_MCP_RESULT_BYTES) throw new ResearchToolError("TOOL_FAILED");
        return { content: [{ type: "text", text }], structuredContent: output };
      } catch (error) {
        return toolError(error);
      }
    });
  }
  return server;
}

function configuredOrigins(origins: readonly string[] | undefined): ReadonlySet<string> {
  const result = new Set<string>();
  for (const origin of origins ?? []) {
    try {
      const parsed = new URL(origin);
      if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin !== origin) throw new Error();
      result.add(origin);
    } catch {
      throw new ResearchToolError("INVALID_CONFIGURATION");
    }
  }
  return result;
}

/** Stateless JSON MCP: authentication precedes body reads, validation and dispatch. */
export function createResearchMcpHandler(options: ResearchMcpHandlerOptions): (request: Request) => Promise<Response> {
  const origins = configuredOrigins(options.allowedOrigins);
  return async (request) => {
    let authenticated = false;
    try { authenticated = await options.authenticate(request) === true; } catch { /* Fail closed without exposing host errors. */ }
    if (!authenticated) return rpcError(401, -32000, null, "Authentication required.");

    const origin = request.headers.get("origin");
    if (origin !== null && !origins.has(origin)) return rpcError(403, -32000, null, "Browser origin is not allowed.");
    if (request.method !== "POST") {
      const response = rpcError(405, -32000, null, "Only POST is supported.");
      response.headers.set("Allow", "POST");
      return response;
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
      ![null, "identity"].includes(request.headers.get("content-encoding"))) {
      return rpcError(415, -32000, null, "Request content type is unsupported.");
    }

    let body: unknown;
    try { body = await readJson(request); } catch (error) {
      return error instanceof RequestBodyError ? rpcError(error.status, error.messageCode, null, error.safeMessage) : rpcError(400, -32700);
    }
    const rpc = parseRpc(body);
    if (rpc === null) return rpcError(400, -32600);
    const validated = validateOperation(rpc);
    if (validated instanceof Response) return validated;

    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: MAX_MCP_REQUEST_BYTES });
    let server: McpServer | undefined;
    let connected = false;
    try {
      server = createServer(options.invoke);
      await server.connect(transport);
      connected = true;
      const response = await transport.handleRequest(request, { parsedBody: validated });
      if (response.status >= 400) return rpcError(response.status, -32000, rpc.id ?? null);
      if (response.status === 202) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
      const payload: unknown = await response.json();
      // SDK validation details can echo supplied input. Surface only fixed messages.
      if (!isRecord(payload)) return rpcError(500, -32603, rpc.id ?? null);
      if (Object.hasOwn(payload, "error")) {
        const code = isRecord(payload.error) && typeof payload.error.code === "number" && Object.hasOwn(rpcMessages, payload.error.code) ? payload.error.code : -32603;
        return rpcError(200, code, rpc.id ?? null);
      }
      return new Response(JSON.stringify(payload), { status: response.status, headers: responseHeaders });
    } catch {
      return rpcError(500, -32603, rpc.id ?? null);
    } finally {
      if (server !== undefined) await server.close().catch(() => undefined);
      if (!connected) await transport.close().catch(() => undefined);
    }
  };
}
