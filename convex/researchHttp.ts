import { createResearchMcpHandler } from "@bmw-knowledge/mcp";
import { parseResearchToolInput, RESEARCH_TOOL_ERROR_CODES, ResearchToolError, type ResearchToolArguments, type ResearchToolName } from "@bmw-knowledge/mcp/contract";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env, httpAction, type ActionCtx } from "./_generated/server";
import { authorizedResearchRequest } from "./researchSecurity";

async function invokeTool(ctx: ActionCtx, name: ResearchToolName, input: ResearchToolArguments): Promise<Record<string, unknown>> {
  try {
    // Only these fixed capabilities are reachable from the machine bearer. The
    // native Convex administrator's collection/configuration APIs are absent.
    switch (name) {
      case "get_research_brief":
        return await ctx.runQuery(internal.research.getBrief, {});
      case "begin_research_run": {
        const args = parseResearchToolInput("begin_research_run", input);
        return await ctx.runMutation(internal.research.beginRun, args);
      }
      case "search_sources": {
        const args = parseResearchToolInput("search_sources", input);
        return await ctx.runQuery(internal.research.searchSources, {
          ...(args.url !== undefined ? { url: args.url } : {}),
          ...(args.domain !== undefined ? { domain: args.domain } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          limit: args.limit,
        });
      }
      case "submit_discoveries": {
        const args = parseResearchToolInput("submit_discoveries", input);
        return await ctx.runMutation(internal.research.submitDiscoveries, {
          runId: args.runId as Id<"researchRuns">,
          idempotencyKey: args.idempotencyKey,
          discoveries: args.discoveries.map((discovery) => ({
            url: discovery.url, relevance: discovery.relevance, series: discovery.series,
            ...(discovery.title !== undefined ? { title: discovery.title } : {}),
            ...(discovery.topics !== undefined ? { topics: discovery.topics } : {}),
            ...(discovery.language !== undefined ? { language: discovery.language } : {}),
            ...(discovery.bodyStyles !== undefined ? { bodyStyles: discovery.bodyStyles } : {}),
            ...(discovery.referrerUrl !== undefined ? { referrerUrl: discovery.referrerUrl } : {}),
          })),
        });
      }
      case "get_collection_status": {
        const args = parseResearchToolInput("get_collection_status", input);
        return await ctx.runQuery(internal.research.getCollectionStatus, { sourceIds: args.sourceIds.map((sourceId) => sourceId as Id<"sources">) });
      }
      case "finish_research_run": {
        const args = parseResearchToolInput("finish_research_run", input);
        return await ctx.runMutation(internal.research.finishRun, {
          runId: args.runId as Id<"researchRuns">, outcome: args.outcome,
          unresolvedLeads: args.unresolvedLeads.map((lead) => ({ note: lead.note, ...(lead.url !== undefined ? { url: lead.url } : {}) })),
          nextDirections: args.nextDirections,
        });
      }
      case "save_research_report": {
        const args = parseResearchToolInput("save_research_report", input);
        return await ctx.runMutation(internal.research.saveReport, {
          ...args, runId: args.runId as Id<"researchRuns">,
          citations: args.citations.map((citation) => ({ url: citation.url, ...(citation.title !== undefined ? { title: citation.title } : {}), ...(citation.note !== undefined ? { note: citation.note } : {}) })),
        });
      }
      case "get_research_report": {
        const args = parseResearchToolInput("get_research_report", input);
        return await ctx.runQuery(internal.research.getReport, { reportId: args.reportId as Id<"researchReports"> });
      }
    }
  } catch (error) {
    if (error instanceof ConvexError && error.data !== null && typeof error.data === "object" && "code" in error.data) {
      const code = RESEARCH_TOOL_ERROR_CODES.find((candidate) => candidate === error.data.code);
      if (code !== undefined) throw new ResearchToolError(code);
    }
    throw new ResearchToolError("TOOL_FAILED");
  }
}

export const mcp = httpAction(async (ctx, request) => {
  const handle = createResearchMcpHandler({
    authenticate: (candidate) => authorizedResearchRequest(candidate, env.RESEARCH_MCP_SECRET),
    invoke: async (name, input) => await invokeTool(ctx, name, input),
  });
  return await handle(request);
});
