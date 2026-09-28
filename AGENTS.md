# Package management

Use pnpm for this project. The version is pinned in `package.json`.
Install with `pnpm install --frozen-lockfile`, run the local Convex CLI with
`pnpm exec convex`, and start development with `pnpm dev`.
Use `pnpm exec convex ai-files install` to refresh the generated Convex guidance.
Keep `pnpm-lock.yaml` as the dependency lockfile.

# Project work

Parallel agent work is allowed when useful; finish agents after their assigned work.
Log important decisions in `decisions.jsonl` for resumability and audit.
Keep multi-command development and operations procedures in `RUNBOOK.md`.
Collection uses a maintainer-only developer worker and internal Convex functions.
The research MCP is a separate restricted interface. Keep its credential distinct
from worker and processing credentials, and keep developer transport verification
separate from the actual ChatGPT OAuth connection.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
