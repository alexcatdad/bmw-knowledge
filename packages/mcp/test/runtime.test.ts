import { describe, expect, it } from "vitest";
import { build } from "vite";
import { EdgeVM } from "@edge-runtime/vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AUTHORIZATION, brief, ENDPOINT, runInput } from "./helpers.js";
import { RESEARCH_TOOL_NAMES } from "../src/contract.js";

describe("Web Standard runtime compatibility", () => {
  it("runs real SDK initialize/list/read/write in a browser bundle with no Node globals or runtime code generation", async () => {
    const bundled = await build({
      configFile: false,
      logLevel: "silent",
      build: { write: false, minify: false, lib: { entry: new URL("../src/index.ts", import.meta.url).pathname, formats: ["iife"], name: "ResearchMcp" } },
    });
    const output = Array.isArray(bundled) ? bundled[0] : bundled;
    if (output === undefined || !("output" in output)) throw new Error("Expected one browser bundle.");
    const entry = output.output.find((file) => file.type === "chunk" && file.isEntry);
    if (entry?.type !== "chunk") throw new Error("Expected the bundled runtime entry.");
    expect(entry.code).not.toContain("__vite-browser-external");
    const runtime = new EdgeVM({ initialCode: `${entry.code}\n
      const brief = ${JSON.stringify(brief())};
      const handler = ResearchMcp.createResearchMcpHandler({
        authenticate: (request) => request.headers.get('authorization') === ${JSON.stringify(AUTHORIZATION)},
        invoke: async (name) => {
          if (name === 'get_research_brief') return brief;
          if (name === 'begin_research_run') return {runId:'edge-run',brief};
          throw new Error('Unexpected operation');
        }
      });
      addEventListener('fetch', (event) => event.respondWith(handler(event.request)));
    ` });
    expect(runtime.evaluate("typeof process === 'undefined' && typeof require === 'undefined' && typeof Buffer === 'undefined'")).toBe(true);
    expect(runtime.evaluate("(() => {try {new Function('return 1')();return false;} catch {return true;}})()" )).toBe(true);
    const client = new Client({ name: "edge-sdk-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
      requestInit: { headers: { authorization: AUTHORIZATION } },
      fetch: async (url, init) => runtime.dispatchFetch(String(url), init),
    });
    try {
      // Same narrow SDK 1.30.1 sessionId declaration compatibility bridge.
      await client.connect(transport as Transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([...RESEARCH_TOOL_NAMES]);
      expect((await client.callTool({ name: "get_research_brief", arguments: {} })).structuredContent).toEqual(brief());
      expect((await client.callTool({ name: "begin_research_run", arguments: runInput })).structuredContent).toEqual({ runId: "edge-run", brief: brief() });
    } finally { await client.close(); }
  }, 30_000);
});
