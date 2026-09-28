# BMW Knowledge — Collection MVP

**Version:** 0.2
**Date:** 28 September 2026  
**Owner:** Alex  
**Status:** Development baseline; implementation defaults may change after testing real sources.  
**Repositories:** `bmw-knowledge` (software monorepo) and `bmw-corpus` (separate public corpus). Names are working names; this document does not create either repository.

## 1. Product intent

Build an open-source BMW knowledge project, beginning with E30 and E46. The long-term ambition is a broad, useful knowledge base supported by inspectable source material. The immediate product is the collection system underneath it: discover sources, acquire useful material, preserve its origin, and publish an inspectable corpus.

ChatGPT is the primary researcher. We will deliberately use the existing individual Pro subscription for interactive and scheduled research rather than build a competing local research agent. Convex provides persistent state and the initial acquisition runtime. A separate public GitHub repository holds the publishable corpus. GitHub Actions performs repository-related transformations; the homelab and Woodpecker are available when local execution is useful.

**First useful outcome:** submit one known source, collect it through a Convex Action, publish its captured content and provenance to the corpus repository, and inspect the result through the collection interface.

**MVP outcome:** repeat that loop with research-assisted discovery, one mechanical normalization workflow, and an actually demonstrated scheduled discovery path. Manual operation is a valid first milestone, not a claim that scheduled operation is already complete.

## 2. Working principles

1. **Start with real bytes.** One source and one working path come before scale engineering. Do not introduce storage migration plans, distributed workers, or a general crawler before an observed need.
2. **Use ChatGPT for intelligence.** Research direction, source discovery, relevance assessment, and follow-up research belong primarily to ChatGPT. Local GPU compute is reserved mainly for later embeddings and related workloads.
3. **Substitute capabilities rather than block development.** Scheduled Deep Research is not a dependency. Use available search, interactive Deep Research, or a suitable external search integration. Changing the research tool must not invalidate collected data.
4. **Use existing services before building equivalents.** Try direct Convex fetching first. Evaluate Cloudflare's crawl/browser service before implementing browser acquisition or recursive crawling ourselves.
5. **Constrain the prototype.** Begin with one maintainer-approved source in a sandbox deployment. Expand sources, formats, and permissions after inspecting results.
6. **Keep evidence separate from interpretation.** Captured content is not a verified BMW fact. Normalization must not silently rewrite the source.

## 3. Users and the problem being solved

**Maintainer:** Alex directs research, inspects acquired material, and decides the next experiment without repeatedly copying URLs between tools.

**Research agent:** ChatGPT needs persistent knowledge of previously discovered sources and recent work, plus a controlled way to submit new discoveries. Its useful output is not just a conversational report: discoveries become collection records.

**Developer or contributor:** can inspect the code and public corpus separately, understand where material came from, and run the same normalization outside GitHub Actions.

A representative future question is: “How many speaker positions does an E30 Touring have, and what are their dimensions?” This release does not answer that question. It should help collect the relevant Touring-specific pages, documents, and eventually images, preserving enough context for a later system or person to investigate it. It must not invent dimensions or claim the question is answered because a search snippet exists.

## 4. Scope

| Build for this MVP | Add when a real sample needs it | Not part of this release |
|---|---|---|
| E30/E46 discovery scope and lightweight topic labels | Additional BMW generations and supplier research | A full BMW ontology or knowledge graph |
| Interactive research and a scheduled discovery integration | Additional search providers or researcher roles | A custom autonomous research framework |
| Restricted collection MCP and Convex state | Additional MCP clients or a different transport host | General database administration through the research MCP |
| One allowlisted HTTP acquisition path | Browser capture, document downloads, bounded multi-page collection | Internet-scale recursive crawling |
| Public corpus bytes, metadata, and hashes | More artifact types and source-specific handling | Object-store migrations, LFS rollout, repository sharding |
| One deterministic HTML/text normalization path | PDF text processing or other format-specific tools | LLM fact extraction, reconciliation, OCR pipelines |
| Basic status, visible errors, safe manual reruns | More automated recovery after observed failures | Temporal or a distributed workflow platform |

Embeddings, RAG, semantic search over source contents, the final wiki, and a custom management UI are explicitly deferred. Lookup of known URLs and metadata is in scope and does not require embeddings.

## 5. Architecture and ownership

```text
ChatGPT: interactive + scheduled discovery
                  |
        Collection MCP interface
                  |
                Convex
       state + acquisition actions
                  |
        direct HTTP acquisition
          [browser service later]
                  |
     Convex file storage: retained originals
                  |
       bmw-corpus: public GitHub repo
                  |
          GitHub Actions
      validation + normalization
                  |
       collection status in Convex

bmw-knowledge: all implementation and research instructions
Homelab / Woodpecker: optional local execution and fallback
Mac Studio: later embedding and ML workloads
```

### Chosen responsibilities

| Component | Responsibility |
|---|---|
| ChatGPT | Research, source discovery, relevance notes, follow-up decisions, and scheduled discovery where the selected execution mode supports the needed tools |
| Collection MCP | Small authenticated interface to collection operations; implementation belongs in the monorepo |
| Convex | Sources, research history, jobs, capture metadata, native file storage for retained POC originals, publication references, and initial acquisition actions |
| Public corpus repository | Published captured content, provenance manifests, and small normalized outputs |
| GitHub Actions | Transform and validate material already acquired and published; no acquisition crawler |
| Homelab | Optional acquisition/processing runtime; Ryzen 9, 32 GB RAM, existing Woodpecker CI |
| Mac Studio | Later embeddings and suitable local ML; not required to complete collection MVP |

Use TypeScript for the first implementation. Prefer a simple workspace monorepo; package-manager and folder details are implementation choices, not product dependencies.

Convex Actions support external requests and database interactions through queries and mutations. Record intent in a mutation, then schedule the acquisition action. Do not assume external side effects are automatically retried or transactional. [R1]

Prefer hosting the remote collection MCP through Convex HTTP actions if the chosen MCP library and client work there. HTTP actions provide the HTTP endpoint primitives; they are not an MCP server by themselves. Test this with one read and one write operation. [R2]

If a different transport host is materially easier, use a thin Cloudflare Worker or another suitable endpoint without moving collection logic out of Convex. Do not build both paths pre-emptively. Convex's development MCP is separate from the restricted application interface. [R7]

### Execution alternatives, not additional mandatory services

Cloudflare Browser Run's crawl endpoint can provide bounded crawling and HTML results. Use it only when the first sources demonstrate a need for browser capture or link traversal; request source content rather than AI-extracted facts. Record whether the result is rendered HTML or an HTTP response body. [R3]

Vercel Functions and local Woodpecker jobs remain alternative execution locations. No Vercel deployment, Cloudflare Worker, local worker pool, Postgres, MinIO, or Temporal installation is required for the initial path.

## 6. End-to-end workflow

### 6.1 Discover

The researcher obtains a compact brief containing the E30/E46 scope, recent discoveries, recent research summaries, and the current acquisition allowlist. It uses available search/research tools, checks known sources when useful, and submits a batch of leads with URLs and short relevance notes.

Discoveries may be broader than the acquisition allowlist. New domains are recorded as leads, not automatically fetched. A single researcher may choose different research directions across runs; fixed specialist agents are not required.

### 6.2 Acquire

A submission for the approved source creates a small acquisition job. A Convex Action retrieves the configured URL, verifies the expected response type, records retrieval metadata, and hashes the captured bytes.

For the POC, persist those bytes in native Convex file storage before publication, as selected by the maintainer. Keep the file ID internal and verify its hash and length against immutable capture metadata. Retain originals through publication and processing; a publication failure resumes the same saved capture. This supersedes the initial S3 staging choice for the POC. S3 remains an explicit alternative, with each capture's backend pinned at reservation.

Begin with one ordinary HTML or text page. No browser or multi-page traversal is required. Other formats may be recorded as unsupported leads until needed.

The initial source should be both safe to fetch and approved for public redistribution. A clearly labelled project-owned fixture is acceptable to wire the integration. It is a test artifact, not genuine BMW evidence; follow it with a manually selected real source.

### 6.3 Publish

The publisher writes the captured artifact and a provenance manifest to the separate corpus repository. A direct commit to a configured branch is sufficient for the initial trusted-source path. Community contribution and generalized PR approval workflows are deferred.

Generate repository paths server-side. Source content and research output cannot choose arbitrary files to overwrite. Mark publication successful only after the expected objects and manifest exist at a recorded repository revision.

GitHub's repository-contents API supports creating or updating files; it is an available first implementation, not a requirement to build a Git abstraction. [R4]

### 6.4 Normalize

A repository workflow validates the manifest and artifact hash, then runs one processor from a pinned version of the monorepo. For the first HTML fixture, produce readable text or Markdown with links preserved where supported.

Keep the captured input unchanged. Record the processor version, input hash, output hashes, and warnings. Do not claim diagrams, layout, or attachments were preserved if the processor did not handle them.

A trusted workflow may commit the small derived outputs. Its trigger must exclude derived-only changes to avoid loops. Report processing success or failure to Convex through a narrow authenticated operation.

### 6.5 Continue research

The next interaction reads updated collection state and sees what was acquired, published, failed, or left as a lead. It can investigate another source instead of repeating the same search. Failed acquisition is a useful recorded outcome, not a reason to fabricate a completed capture.

## 7. Functional requirements

| ID | Requirement | Observable acceptance |
|---|---|---|
| FR-01 | Maintain configurable research scope, beginning with E30/E46. | The brief shows the scope; it can be changed without schema redesign. |
| FR-02 | Supply compact research context and known-source lookup. | A researcher sees prior discoveries without receiving the entire corpus. |
| FR-03 | Register batches of discoveries with provenance of discovery. | Each accepted item returns a persistent ID and accepted/known/deferred status. |
| FR-04 | Support repeated submissions safely. | Replaying the same batch does not create duplicate jobs; identical bytes reuse the same artifact identity. |
| FR-05 | Acquire one approved source through a Convex Action. | The stored content matches the captured response bytes, with URL, retrieval time, type, size, and hash recorded. |
| FR-06 | Publish approved material to the separate corpus repository. | Published records resolve to actual content and a manifest at a Git revision. |
| FR-07 | Preserve failed and incomplete outcomes honestly. | A failed request is visible with a reason; it is not counted as a published source. |
| FR-08 | Perform one reproducible normalization. | The processor runs locally and in Actions on the same input, producing matching declared outputs. |
| FR-09 | Permit inspection and reruns without building a UI. | MCP, a small developer command, and Convex's dashboard are sufficient to inspect or retry the sample. |
| FR-10 | Demonstrate scheduled discovery against persistent state. | An actual scheduled execution produces records, and a subsequent execution or interaction reads them. |

A one-page acquisition does not imply a complete website archive. Unsupported attachments and pagination should be visible in notes when encountered; implementing their acquisition is subsequent work.

## 8. Research execution and MCP contract

### Research execution

The primary goal is scheduled ChatGPT discovery using the existing subscription. Interactive ChatGPT is also a first-class client, and manual Deep Research can supply discoveries when useful.

Do not require Deep Research inside scheduled executions. Available tools and connected-app permissions depend on the selected product mode and account; test the actual scheduled path while the basic collection path is being developed. [R5][R6]

External search is an optional tool substitution, not an architecture change. Select a usable provider or integration when needed. Do not assume a service exposes a suitable free search API simply because its public search site is free.

If the chosen scheduled mode cannot write through our MCP, report that limitation and retain an explicit discovery-batch import or interactive submission path. A fallback keeps collection development moving; it does not satisfy FR-10 until an automated path is demonstrated. Changing the scheduled client is an option to evaluate, not a reason to rebuild the backend.

Do not silently add paid OpenAI API usage or automate the ChatGPT website to simulate supported integrations. Exact cadence and provider settings are configuration. Create no recurring task merely by implementing this PRD.

### Initial MCP tools

These names are proposed; the behaviors are required.

| Tool | Purpose |
|---|---|
| `begin_research_run` | Record a run and return its ID plus the compact discovery brief. |
| `search_sources` | Find known sources by URL, domain, title, or topic metadata. |
| `submit_discoveries` | Accept a batch with an idempotency key; return IDs and acquisition/deferred status. |
| `get_collection_status` | Read source/job/capture/publication state and actual corpus references. |
| `finish_research_run` | Record a short outcome, unresolved leads, and useful next directions. |

Authentication and tool input validation happen at the server. Store only a short research summary, not hidden reasoning. Source publication approval is maintainer configuration, not a decision granted to arbitrary agent tool input.

A maintainer-only developer command may retry failed jobs or import a discovery batch through the same application functions. Do not expose generic SQL, arbitrary Convex function execution, or deployment administration to the research client.

### Versioned research instruction

Keep the instruction in the monorepo. Its essential behavior is:

> Read the collection brief and recent work. Discover useful E30/E46 information sources using available research tools. Check known sources when relevant. Submit new URLs with a brief explanation, topic/body-style/language hints where apparent, and the source through which you discovered them. Do not extract automotive facts. Do not claim an item was collected until collection status confirms it. Finish with a short outcome and promising next leads.

Source titles and original languages should be retained. English is the initial operational language; non-English source discovery is allowed without automatic translation.

## 9. Minimal data model

This is a starting model, not a demand for an elaborate schema. Related records may be embedded where that is simpler.

| Record | Essential information |
|---|---|
| Research run | ID, client/mode, objective, instruction version, start/end, short outcome |
| Source/lead | ID, original URL, conservative lookup key, optional title/topics/language, discovery time, discovery run/referrer, collection eligibility |
| Acquisition job | ID, source ID, submission key, status, attempt count, timestamps, error or capture result |
| Capture | ID, source/job IDs, requested/final URL, fetched time, HTTP result, capture kind, content hash, completeness note, publication status |
| Artifact | SHA-256 identity, media type, byte length, corpus path/revision once published, normalization status |

Start with `queued`, `running`, `succeeded`, `failed`, and `skipped` job states. Acquisition/publication completion and normalization completion must remain distinguishable.

A URL may change over time. Multiple URLs can lead to identical bytes. Preserve the distinct source/capture records while sharing an artifact by hash. Do not overwrite an old capture to pretend it was newly fetched. Re-acquisition should be explicit; re-submission of a known lead need not trigger a fresh download.

Convex owns live operational state. Corpus files own the published evidence and manifests. A manifest must remain intelligible without database access. The manifest need not embed the SHA of its own commit; store that publication locator in Convex or an external result record.

### Suggested repository boundaries

```text
bmw-knowledge/
  convex/                  # State, actions, HTTP entry points
  packages/collection/     # Fetching/publishing helpers
  packages/mcp/            # Tool definitions and thin adapter
  packages/normalization/  # One shared processor initially
  packages/schemas/        # API and corpus validation
  research/                # Instructions and example briefs
  fixtures/                # Labelled test material
  docs/PRD.md
  .github/workflows/

bmw-corpus/
  sources/                 # Public source metadata
  captures/                # Capture/provenance manifests
  raw/sha256/              # Captured artifacts
  normalized/              # Small versioned derived outputs
  processing/              # Input/output hashes and processor versions
  .github/workflows/       # Thin calls into pinned monorepo tooling
  README.md
```

The exact folder layout may be simplified. Keep the two repositories separate. Do not put operational logs, secrets, embeddings, application code, or temporary browser files in the corpus.

## 10. Prototype operating boundaries

Use one sandbox deployment and one maintainer-configured source host/path. Discovery can record other leads, but acquisition must reject out-of-scope URLs and redirects. Set a request timeout and maximum response size appropriate to the first sample; these are configurable runtime safeguards, not corpus growth targets.

Keep write credentials server-side and restricted to the intended deployment and corpus repository. Use the supported authentication flow of the selected MCP client. Downloaded material is data, not executable instructions; never derive shell commands or executable workflow files from it.

Only publish source content for which the maintainer has approved redistribution. Unapproved material remains a reference-only lead or manifest without its body. Do not build a licensing engine for the first source, and do not assume making a repository open source licenses third-party content.

Basic manual retry is sufficient initially. Handle ordinary failed fetches and publication errors visibly. Before repeating a publication, check whether its expected artifact and manifest already exist. Do not introduce a distributed lease system or generalized recovery framework for the single-worker prototype.

Use existing subscriptions, ordinary free tiers, and owned hardware. Do not activate paid providers or upgrade plans automatically. Record observed usage and failures; solve actual limits when encountered. No storage-size milestone is a prerequisite to collecting the first page.

## 11. Development slices

| Slice | Implement | Exit condition |
|---|---|---|
| 1 — First source | Minimal Convex records; developer submission command; one allowlisted fetch; artifact/hash/manifest publication. | One permitted source is inspectable in the corpus and its status is correct in Convex. No MCP or scheduler dependency for this slice. |
| 2 — Research interface | Thin MCP; interactive ChatGPT submission; brief and known-source lookup; batch idempotency. | ChatGPT can submit and inspect a collection without manual database edits. |
| 3 — First transformation | One processor, manifest/hash validation, corpus workflow, result callback. | The captured source remains intact; normalized output is inspectable and reproducible locally. |
| 4 — Scheduled discovery | Versioned instructions; configure and test the actual supported scheduled path; preserve run results. | An actual scheduled execution submits discoveries and uses persistent collection context. |
| 5 — First expansion | Inspect the initial real samples; choose one new source or capture capability based on a concrete gap. | The change addresses an observed problem, such as a rendered page or a linked document, without redesigning the system. |

Slices 1–4 define the initial MVP. Slice 5 is the next iteration, not a release prerequisite. Scheduled-path exploration may run alongside the other slices. Do not implement every fallback runtime before the first source works.

## 12. Definition of done and measures

The collection MVP is complete when:

- A researcher can read context, submit a source, and inspect its collection result.
- At least one real, permitted source is acquired and published with traceable provenance; test fixtures are visibly distinguished.
- Replaying a discovery batch does not duplicate its work, and an ordinary failure can be inspected and retried.
- One normalization runs through GitHub Actions and the same processor works outside CI without changing the captured input.
- Scheduled discovery has been demonstrated in an actual run; unsupported tools or manual bridges are documented rather than described as working automation.
- Setup instructions let another developer reproduce the sample with their own deployment and credentials.

Track discovered sources, distinct captured artifacts, successful publications, duplicates, failures, normalization outcomes, research runs, and interventions needed to complete the loop. These are observational measures, not scale targets. Do not report percentage coverage of E30/E46 without a defined denominator.

The important learning question is: **Can we repeatedly obtain useful source material, know where it came from, and continue research with less manual handling?**

## 13. Implementation handoff

Start with Slice 1. Use a project-owned fixture if necessary to prove the plumbing, then one manually approved real source. Keep the first functions small and directly callable. Add the MCP and scheduled client around the working collection behavior rather than building an agent platform first.

Do not create the final wiki, a vector index, a general-purpose crawler, a multi-cloud dispatcher, or a production-scale security program. Document actual obstacles and make the next change in response to one of them.

Deployment identifiers, GitHub owner/repository names, the approved source URL, credentials, the supported ChatGPT connection mode, and schedule cadence are implementation configuration still to be supplied or tested. Their absence does not prevent developing and testing Slice 1 against fixtures.

## 14. Platform references

Official documentation checked on 28 September 2026. These references justify individual platform capabilities; they do not establish that the complete scheduled ChatGPT-to-MCP path has been tested on the owner's account. Product limits and tool availability should be checked in-product during setup rather than frozen into this PRD.

**[R1] Convex — Actions.** External requests, JavaScript/Node runtimes, calling queries/mutations, mutation-then-schedule pattern, and error handling.  
`https://docs.convex.dev/functions/actions`

**[R2] Convex — HTTP Actions.** HTTP endpoint primitives and invoking Convex functions.  
`https://docs.convex.dev/functions/http-actions`

**[R3] Cloudflare Browser Run — Crawl endpoint.** Bounded crawling, capture formats, rendering options, asynchronous results.  
`https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/`

**[R4] GitHub — Repository contents REST API.** Creating/updating repository files and repository-scoped credentials.  
`https://docs.github.com/en/rest/repos/contents`

**[R5] OpenAI — Scheduled tasks in ChatGPT.** Scheduling and connected-tool behavior; account/mode-specific verification remains necessary.  
`https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt`

**[R6] OpenAI — Deep research in ChatGPT.** Interactive research and availability of supported data sources/apps.  
`https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt`

**[R7] Convex — Convex MCP Server.** Development tooling, separate from this project's collection interface.  
`https://docs.convex.dev/ai/convex-mcp-server`
