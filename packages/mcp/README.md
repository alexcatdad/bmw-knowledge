# Research MCP package

`createResearchMcpHandler({ authenticate, invoke, allowedOrigins? })` returns a
Web Standard `Request` → `Response` handler. The host authenticates every request
and dispatches the eight fixed operations to its backend. Each accepted POST
uses a fresh official SDK server/transport in stateless JSON response mode.

The runtime-neutral `/contract` export contains strict input schemas, bounded
native output schemas, tool names/annotations, versioned research instructions,
and fixed `ResearchToolError` codes. Unknown functions, admin operations, source
approval fields, arbitrary file paths, and JSON request batches are rejected.
Successful results have native `structuredContent` matching the tool's output
schema. Failures have `isError: true` and one text block containing JSON with
`error.code` and `error.message` from the fixed whitelist and message map. They
omit `structuredContent` so SDK clients do not apply a cached success schema to
an error payload.

Bodies are capped at 192 KiB of observed UTF8 input and a 15-second body deadline.
Browser `Origin` is denied unless explicitly allowlisted. Authorized GET/DELETE
requests return 405; an absent or rejected host credential returns 401.

Manual reports retain citations and the labels `manual_research_report` and
`unverified_research`. Saving one does not acquire citations or publish captured
content. This package does not provide OAuth, run Deep Research, create a
schedule, or establish a ChatGPT account connection.

From the workspace, run `pnpm --filter @bmw-knowledge/mcp typecheck` and
`pnpm --filter @bmw-knowledge/mcp test`. Tests use the real SDK client with an
in-memory backend and a browser bundle in a Web Standard VM with runtime code
generation disabled. Deployment and client acceptance steps are in the root
`RUNBOOK.md`.
