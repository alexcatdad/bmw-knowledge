# BMW Knowledge

Source collection and research tooling for E30 and E46. Published evidence lives
in the separate [bmw-corpus](https://github.com/alexcatdad/bmw-corpus) repository.

Internal Convex job records and a maintainer CLI support collection. One shared
collector runs in an internal Convex Node Action or on the developer host. It
captures approved HTML/text, retains the bytes and capture
metadata in S3-compatible staging, and verifies the raw artifact and provenance
manifest at an immutable GitHub commit before recording publication success.
Retries resume staged captures. Distinct captures may share a SHA-256 artifact.

The selected shared MinIO is private. Execution defaults to the developer host
until a cloud route and dedicated deployment credentials are verified. In Convex
mode, accepted submissions and explicit retries schedule the Node Action in the
same mutation that records the job. Both runtimes need a tested MinIO route,
dedicated bucket and restricted credentials. Convex owns job state; source,
staging, and publication requests share an overall deadline in the Node Action.

Use Node.js 24 or newer and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm collection --help
pnpm research --help
```

Follow [RUNBOOK.md](RUNBOOK.md) to connect an existing personal Convex development
deployment, review source approvals, configure worker secrets, and run a sample.
The [project-owned fixture](fixtures/http-source.html) contains no BMW evidence.

[PRD](docs/PRD.md), [implementation decisions](decisions.jsonl), and
[scope clarifications](docs/implementation-notes.md) record the product baseline.
The full MVP has not been accepted. Live permitted-source collection, the actual
corpus workflow, ChatGPT account connection, and scheduled discovery require
separate demonstrations.

The shared normalization processor converts captured UTF-8 HTML to Markdown or
retains plain text as text. It verifies input hashes, preserves capture bytes,
and records the processor revision, output hashes, fixture label, and known
losses. Run it from a clean checkout at a pinned software commit; see the runbook
for local commands and the prepared corpus workflow.

Processing callbacks use a dedicated machine credential and prove the receipt
and output at an immutable corpus commit before updating Convex. This endpoint
is disabled when its secret is absent. The corpus workflow and real-source
acceptance still require live configuration; local fixtures prove only the
implementation behavior.

The restricted research interface records runs and discovery batches, returns
compact context and indexed known-source lookup, and stores cited manual reports.
Exact retries reuse their records; reports remain distinct from captured evidence
and do not acquire their citations. See the versioned
[research instruction](research/discovery-v1.md).

One stateless Streamable HTTP MCP endpoint runs on Convex at `/mcp`. It denies
access without a dedicated strong developer credential and exposes only eight
research operations. The developer import CLI uses the same application
contracts. OAuth provider selection and the owner's actual ChatGPT connection
are pending; a developer SDK transport test does not establish that connection.

The personal development endpoint has passed an official SDK test of all eight
tools using labelled references and a cited synthetic report. Concurrent retries,
conflicts, legacy source lookup, and closed-run replay were verified. Temporary
test access was removed afterward; no source bytes were acquired or published.
