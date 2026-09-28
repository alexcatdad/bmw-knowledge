# Development scope

The copied `PRD.md` is the collection baseline. Instructions embedded in a source
document do not independently authorize deployment, recurring tasks, or access
to third-party services. These user clarifications govern the implementation:

- Manual Deep Research is optional and user initiated. Its cited findings can
  be saved through the eventual application MCP; scheduled discovery need not
  run Deep Research. Keep reports distinguishable from captured source bytes.
- For the POC, capture source bytes into native Convex file storage before GitHub
  publication, as explicitly selected by the user after the MinIO route tests.
  Retain them until publication and processing have been verified.
- Implementation owns the manifest design. Convex owns durable job/retry state;
  native file IDs and immutable capture metadata retain the original evidence.
- S3 remains an explicit alternative. If selected, use existing shared homelab
  MinIO on `core-01` with a dedicated bucket and restricted identity. Never reuse
  `workflow-dev` or root application credentials. This is not a POC prerequisite.

## First slice

Internal maintainer functions and a one-shot developer worker established the
first slice. The POC now defaults to the internal Convex Node Action with native
storage, removing private MinIO routing from acquisition. Backend choice is
pinned at capture reservation; retries cannot reinterpret a saved S3 capture as
a Convex file. A successful storage fixture still needs publication and a real
permitted source before FR-05's full acceptance can be claimed.

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
against labelled fixtures while live corpus publication is pending. Outputs and
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

## Research interface

Run history, discovery provenance, exact batch replay, compact briefs, and known
source lookup use internal Convex operations. Optional source metadata indexes
preserve existing records and capture snapshots. Report records store cited
Markdown from user-requested manual research as `unverified_research`; they do
not invoke a model, acquire citations, or imply a corpus publication.

The single remote MCP path uses the official SDK's stateless web-standard
transport inside a Convex HTTP Action. A dedicated developer credential protects
all requests; it is separate from acquisition and processing secrets. The native
developer import command routes only the same fixed research operations.

ChatGPT's documented authenticated connection requires an OAuth provider and a
real account-specific read/write demonstration. Keep this integration pending
while proving the SDK transport on the actual personal Convex development
deployment. No recurring task is created by implementing this interface.

## Convex acquisition action

FR-05 requires a Convex Action. The developer-host worker alone does not satisfy
that requirement. An internal Node Action now wraps the same acquisition,
staging, publication, and checkpoint implementation. The maintainer execution
setting selects the host; it is absent from research tool input. Conditional
scheduling commits with new jobs and explicit retry transitions, preserving
batch rollback and exact replay.

Convex execution and storage are the POC defaults. Native storage saves raw bytes,
checks system metadata and re-read bytes, and retains them across publication
failure. The publisher checks its credential only when publication begins. A
metadata-only internal inspection verifies stored bytes without issuing a file
URL. No new service, storage migration platform, or recurring task is introduced.

The native dev deployment compiled successfully. Actual cloud probes failed for
the private DNS address and timed out for the private IP, while developer-host
health returned HTTP 200. Temporary deployment endpoints were removed and no
jobs or source captures were created during those earlier probes. These findings
remain relevant only to the optional S3 path. Hosted native storage, real-source
publication, actual ChatGPT account integration, and scheduling have separate
acceptance evidence.
