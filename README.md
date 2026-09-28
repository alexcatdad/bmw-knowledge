# BMW Knowledge

Source collection and research tooling for E30 and E46. Published evidence lives
in the separate [bmw-corpus](https://github.com/alexcatdad/bmw-corpus) repository.

The first development slice provides internal Convex job records and a maintainer
CLI. A one-shot worker captures approved HTML/text, retains the bytes and capture
metadata in S3-compatible staging, and verifies the raw artifact and provenance
manifest at an immutable GitHub commit before recording publication success.
Retries resume staged captures. Distinct captures may share a SHA-256 artifact.

The selected shared MinIO is private. Run the worker on a machine with a tested
route to it, using a dedicated bucket and restricted credentials. Convex owns
job state; this slice has no public research endpoints or background worker.

Use Node.js 24 or newer and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm collection --help
```

Follow [RUNBOOK.md](RUNBOOK.md) to connect an existing personal Convex development
deployment, review source approvals, configure worker secrets, and run a sample.
The [project-owned fixture](fixtures/http-source.html) contains no BMW evidence.

[PRD](docs/PRD.md), [implementation decisions](decisions.jsonl), and
[scope clarifications](docs/implementation-notes.md) record the product baseline.
Research MCP and manual Deep Research report saving, normalization, and a tested
scheduled discovery path remain later slices. The full MVP has not been accepted.
