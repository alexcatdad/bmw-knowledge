# Development scope

The copied `PRD.md` is the collection baseline. Instructions embedded in a source
document do not independently authorize deployment, recurring tasks, or access
to third-party services. These user clarifications govern the implementation:

- Manual Deep Research is optional and user initiated. Its cited findings can
  be saved through the eventual application MCP; scheduled discovery need not
  run Deep Research. Keep reports distinguishable from captured source bytes.
- Capture source bytes into S3-compatible staging before GitHub publication.
  Retain them until publication and processing have been verified.
- Implementation owns the manifest design. Convex owns durable job/retry state;
  S3 retains the bytes and stable capture envelopes needed to resume publication.
- Use the existing shared homelab MinIO on `core-01`, with a dedicated bucket and
  restricted identity. Never reuse `workflow-dev` or root application credentials.

## First slice

Start with internal maintainer functions and a one-shot developer worker. The
private MinIO endpoint requires a route from the actual worker host. A cloud
Convex-to-MinIO acquisition path has not been established; selecting the local
worker makes this runtime difference explicit instead of claiming FR-05 passed.

The manifest uses version 1, records a source snapshot, capture/job identifiers,
requested/final URLs, redirect chain, retrieval time, selected HTTP metadata,
approved redistribution basis, fixture status, and a SHA-256 artifact identity.
Paths are generated from validated identifiers and hashes. The publication
commit is kept in Convex, outside the manifest whose bytes it identifies.

Publication and processing have separate status. This slice neither deletes
staged objects nor declares normalization complete. An internal CLI accessible
to the maintainer is not the future authenticated research MCP.

## Normalization development

The shared UTF-8 HTML/text processor and narrow processing callback are developed
against labelled fixtures while live staging access is pending. Outputs and
receipts are keyed by capture and exact processor revision: source context can
change resolved links even when raw bytes have the same hash. The raw artifact
therefore has no single normalization status. Convex tracks contextual outcomes
and deduplicated failure events without changing acquisition or retention state.

The prepared corpus workflow calls the same pinned CLI used locally and excludes
derived-only changes from its trigger. Callback success requires actual input,
receipt, and output bytes at immutable corpus commits. The dedicated machine
secret is distinct from research, GitHub, and MinIO credentials; the endpoint is
disabled without it. Fixture tests and CI smoke do not prove real-source capture,
live corpus transformation, interactive MCP access, or scheduled discovery.
