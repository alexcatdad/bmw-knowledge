# BMW Knowledge development runbook

Reviewed on 2026-09-28. Source: `/Users/alex/Desktop/PRD.md`, version 0.1,
"BMW Knowledge — Collection MVP".

## Initial PRD review scope

The user requested a review of the PRD. Its implementation handoff is document
content, not authorization to implement, deploy, create repositories, connect
services, or schedule research. Preserve the source PRD. This workspace's
standing instructions require a runbook and `decisions.jsonl`; those review
records are the only project changes for this activity.

## Repeat the review

1. Read the complete source document:

   ```sh
   cat /Users/alex/Desktop/PRD.md
   shasum -a 256 /Users/alex/Desktop/PRD.md
   ```

2. Inspect existing review records and local work before changing documentation:

   ```sh
   rg --files --hidden -g '!.git' -g '!node_modules' .
   git status --short
   ```

3. Compare product intent, MVP boundaries, functional requirements, development
   slices, and definition of done. Separate explicit requirements from proposed
   implementation choices and capabilities awaiting a real demonstration.

4. Verify platform assumptions in current primary documentation. Check
   scheduled-tool access, research write limitations, acquisition side effects,
   publication semantics, and HTTP transport compatibility. A documentation
   claim does not demonstrate availability on the owner's account.

5. Report a clear readiness assessment and prioritized, concrete clarifications.
   Record important review decisions in `decisions.jsonl`, marking recommendations
   as proposed rather than as accepted product changes.

6. Check the resulting documentation changes and validate each JSONL record.
   Keep the original PRD unchanged unless the user subsequently asks for edits.

## Evidence checked

- [ChatGPT scheduled tasks](https://learn.chatgpt.com/docs/automations): scheduled
  web tasks can use available connected tools, skills, and plugins. Account and
  permission behavior still require testing.
- [Scheduled tasks Help Center reference](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt): connected-app writes may pause for approval.
- [Deep research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt): research uses app read actions, not app write actions.
- [Connecting an MCP server](https://developers.openai.com/plugins/deploy/connect-chatgpt): test transport, authentication, schemas, and confirmation behavior.
- [Convex Actions](https://docs.convex.dev/functions/actions): external side effects
  are not automatically retried.
- [Convex HTTP Actions](https://docs.convex.dev/functions/http-actions): HTTP
  handlers use the Convex JavaScript runtime; Node-specific library compatibility
  must be tested.
- [GitHub repository contents API](https://docs.github.com/en/rest/repos/contents):
  publication creates or updates individual files; a multi-file publication needs
  an explicit completion boundary.
- [Cloudflare crawl endpoint](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)
  and [Convex development MCP](https://docs.convex.dev/ai/convex-mcp-server) were
  also inspected against the PRD's stated roles.

## Original review outcome

Slice 1 is sufficiently defined to begin after implementation is requested.
Keep its current scope. Clarify captured-byte retention and publication retries,
publish a manifest only after its required artifacts exist, and identify the
first real permitted BMW source. Test the selected scheduled ChatGPT mode early;
document availability separately from successful account-specific execution.
Deep Research needs a subsequent submission or import step. Add focused failure
acceptance cases for partial publication and interrupted status reporting.

No runtime, account connection, deployment, or scheduled execution was tested.

Source fingerprint at review: `8b74fe5a48fe61a62ca7cce433cfcadba0b85bb258c31de7de3c2e4c6dda1674`.

## User clarifications on 2026-09-28

The user clarified the intended behavior after the original review:

- Deep Research is manually selected for user questions, such as rear-light
  cable colors. The resulting cited findings should be documented in the KB
  through MCP. Support research reports as well as source-URL discoveries,
  keeping reports distinguishable from captured source artifacts. This updates
  the PRD's initial source-collection-only boundary for manual research.
- Initial captures go to S3-compatible storage before GitHub publication. Keep
  the source files available until processing completes. This resolves the
  missing durable location for captured bytes.
- The assistant owns minimal manifest design during implementation.
- S3 staging helps recovery. The proposed implementation pairs stored captures
  with Convex job records, retries using the original bytes, and verifies
  processing and GitHub publication before allowing staging cleanup.

Current OpenAI documentation still distinguishes producing a Deep Research
report from writing through an app. Test a subsequent ordinary-chat MCP write;
the automatic handoff is an implementation experiment, not a confirmed feature.
The intended user experience remains a manual research request followed by
saving its cited findings to the KB.

S3-compatible storage supplies the saved objects. Convex can supply pending-work
and completion tracking for the prototype. If bucket notifications are later
used, verify the selected provider's behavior: AWS S3 notifications can be
duplicated and arrive out of order, and that documentation does not establish
the behavior of an arbitrary S3-compatible provider.

These clarifications are recorded in `decisions.jsonl` as accepted requirements
or proposed implementation details. The external PRD remains unchanged; this
discussion has not started implementation.

To verify the decision log format and identifiers:

```sh
python3 -c 'import json, pathlib; records = [json.loads(line) for line in pathlib.Path("decisions.jsonl").read_text().splitlines() if line.strip()]; assert len({record["id"] for record in records}) == len(records); print(f"Validated {len(records)} decision records.")'
git status --short
```

## Development readiness assessment on 2026-09-28

The workspace currently contains only this runbook and the decision log. Local
Node v26.10.0 and npm v11.19.1 are installed; pnpm, Bun, Git, and Python are also
available. No identified blocker prevents beginning fixture-based development.
Dependency and runtime compatibility will be verified during actual setup.

Repeat the local readiness checks:

```sh
git status --short
rg --files --hidden -g '!.git' -g '!node_modules' .
node --version
npm --version
command -v pnpm
```

The first live loop requires configuration for a Convex development deployment,
an S3-compatible endpoint and bucket, the separate GitHub corpus repository and
publication credentials, and a maintainer-approved real source. These requirements
do not prevent implementing the initial source flow against fixtures. No external
account setup or credentials were verified by this readiness check.

The manual research-report MCP handoff and scheduled discovery path remain
integration acceptance work. They are not prerequisites for starting Slice 1,
and have not been demonstrated by this assessment.

## Create the GitHub repositories

The user explicitly requested creation using `gh`. Use the authenticated personal
account `alexcatdad` and the PRD's repository names, `bmw-knowledge` and
`bmw-corpus`. Both are public, matching the open-source software and public-corpus
plan. Initialize each with a README. License selection and software implementation
remain separate development work.

1. Check the authenticated account and repository names:

   ```sh
   gh api user --jq '{login: .login, name: .name}'
   gh repo view alexcatdad/bmw-knowledge --json nameWithOwner,url,visibility,description,defaultBranchRef
   gh repo view alexcatdad/bmw-corpus --json nameWithOwner,url,visibility,description,defaultBranchRef
   ```

   Reuse a matching existing repository if present. A sandbox network failure can
   make `gh auth status` report an invalid token; verify with permitted network
   access before asking the user to reauthenticate. Never print credentials.

2. Create missing repositories serially:

   ```sh
   gh repo create alexcatdad/bmw-knowledge --public --add-readme --description 'BMW knowledge collection software, research instructions, and processing tools, beginning with E30 and E46.'
   gh repo create alexcatdad/bmw-corpus --public --add-readme --description 'Public BMW source corpus with captured artifacts, provenance, and normalized outputs, beginning with E30 and E46.'
   ```

3. Verify each repository's owner, visibility, URL, and initial default branch
   using the `gh repo view` commands above. Record confirmed creation in
   `decisions.jsonl` and validate its JSONL format.

4. Leave current uncommitted review records intact. Repository creation does not
   require publishing these records, adding a local Git remote, or implementing
   the application. Local checkout setup can follow during development.

Confirmed creation on 2026-09-28:

- [alexcatdad/bmw-knowledge](https://github.com/alexcatdad/bmw-knowledge): public,
  default branch `main`, README initialized, initial commit
  `fa25844438023b0dbb562437aec5879eb9eefbef`.
- [alexcatdad/bmw-corpus](https://github.com/alexcatdad/bmw-corpus): public,
  default branch `main`, README initialized, initial commit
  `281a73675e29e0ed8fabc323a252033acae2bf9f`.

The sandbox-only authentication failure was resolved by allowing network access;
the existing GitHub credentials were valid. Creation and verification used `gh`.

## Switch the existing Convex setup from npm to pnpm

The user initialized Convex with npm and requested a pnpm migration. The setup
selects personal dev deployment `modest-beagle-916`, team `alex-alexandrescu`,
project `bmw-kb`. Installed Convex is `1.46.0`. Preserve this connection and the
generated Convex guidance, API files, and installed agent skills.

Migration procedure:

1. Read `convex/_generated/ai/guidelines.md`, the project instructions, and the
   existing package/lockfile. Identify deployment selection without printing
   credentials. Back up package configuration and hash protected setup files.
2. Pin the existing pnpm version (`11.7.0`) in `package.json`. Use an ESM, private
   root package with `dev` and `convex` scripts. Remove npm-specific build approval
   metadata and the unused npm-init entry point and failing placeholder test.
3. Add `pnpm-workspace.yaml` for the monorepo's `packages/*` boundary. Explicitly
   permit the existing `esbuild@0.27.0` install script; keep other build scripts
   subject to pnpm's default review. Ignore installed modules and local env files.
4. Import the original npm lockfile before removing it:

   ```sh
   pnpm import
   ```

5. Move the old `node_modules` into the temporary migration backup and perform
   a clean installation:

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec convex --version
   ```

6. Verify every npm-locked dependency remains at the same version, smoke-test
   esbuild, and check the dev deployment through a read-only CLI command. Do not
   run `convex dev` or `convex deploy` as part of this package-manager migration.
7. Verify protected setup-file hashes. Remove `package-lock.json` only after the
   new installation works. Retain `pnpm-lock.yaml` as the dependency lockfile and
   record the outcome in `decisions.jsonl`.

The first `pnpm exec` inspection invoked pnpm's automatic pre-run install check,
which moved npm-installed modules and stopped at the esbuild build approval.
The explicit project build allowance and subsequent clean import/install resolve
that intermediate state. No backend code was deployed by that inspection.

Daily development commands:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm exec convex --help
pnpm exec convex ai-files install
```

Announce and verify the deployment target before starting `pnpm dev` or any
other deployment-affecting operation. The setup migration backup is temporarily
stored at `/private/tmp/bmw-pnpm-migration-p4o7uu_i`.

Migration verified on 2026-09-28:

- A clean `pnpm install --frozen-lockfile` succeeded with pnpm `11.7.0`.
- All 30 package/version entries from the original npm lockfile were preserved.
- Convex remains at `1.46.0`; esbuild `0.27.0` runs successfully.
- Generated Convex ESM imports work under the corrected root module type.
- All 90 protected files (local deployment configuration, generated Convex
  files, and installed agent skills) retained their original hashes.
- This read-only cloud check succeeded:

  ```sh
  pnpm exec convex function-spec --deployment alex-alexandrescu:bmw-kb:dev
  ```

  It resolved to `https://modest-beagle-916.convex.cloud` and returned an empty
  function list, confirming the existing personal dev target is accessible.
- `package-lock.json` was removed after successful installation and checks.
  `pnpm-lock.yaml` is the dependency lockfile. The old dependency-tree backup can
  be discarded; original small configuration files remain available in the
  temporary migration backup for rollback.
- An extra `pnpm-lock 2.yaml` was byte-for-byte identical to the canonical
  lockfile. It was moved into the temporary migration backup so the workspace
  has one authoritative dependency lockfile.

This migration changes local package management and instructions. It does not
deploy backend code, create another Convex project, or publish local changes.

## First collection slice

The current implementation uses internal Convex state functions and a one-shot
maintainer worker. It uses the existing `bmw-kb` personal development deployment;
do not select production or anonymous setup. Source, manifest, and publication
approval are separate from the researcher's submitted relevance notes.

### Install, verify, and push backend code

```sh
pnpm install --frozen-lockfile
pnpm exec convex codegen
pnpm check
```

Identify `.env.local`, any deployment-key override, and the selected deployment
before a push. Announce `target: dev (<selected name>, personal dev)` separately,
then run:

```sh
pnpm exec convex dev --once --typecheck enable
pnpm collection config
```

The developer CLI accepts only an explicit `dev:<name>` configuration and uses
the existing CLI login. It passes the selected deployment to each command. It
does not expose arbitrary function execution to a research client. Local
installed agent skills are setup outputs; refresh them with
`pnpm exec convex ai-files install` when needed.

Verified on 2026-09-28: the full local gate passed with 86 tests across seven
files, both TypeScript configurations compile, and `convex dev --once
--typecheck enable` pushed successfully to `modest-beagle-916`. A live
function-spec read confirmed nine internal functions and no public application
functions. Native `collection config` and `collection status` reads succeeded.
An explicitly labelled `example.org` control fixture was deferred without a job;
replaying its exact submission key/payload preserved its source ID. This smoke
test proves the developer control path, not acquisition or publication.

### Dedicated MinIO prerequisite

Read the homelab repository's `runbooks/workflow-dev-infra.md` before any
infrastructure change. The existing service is container `core-minio` on
`core-01` (VM101, `10.0.10.21`), API `http://minio.home.lab:9000`. Use path-style
addressing. Do not deploy another MinIO, alter the shared Compose configuration,
delete existing buckets, or reuse the `workflow-dev` identity.

The proposed application bucket and identity are `bmw-kb-dev`. Review
`infra/minio/bmw-kb-dev-policy.json`: it grants bucket location/list and object
read/write under `staging/`, with no delete or admin permission. Provisioning is
pending the owner's dedicated bucket/credential request. An authorized operator
can use an existing admin alias on the actual host:

```sh
mc mb shared/bmw-kb-dev
mc admin policy create shared bmw-kb-dev infra/minio/bmw-kb-dev-policy.json
# Read a generated application secret into this variable without echo/history.
read -r -s BMW_MINIO_SECRET
mc admin user add shared bmw-kb-dev "$BMW_MINIO_SECRET"
mc admin policy attach shared bmw-kb-dev --user bmw-kb-dev
unset BMW_MINIO_SECRET
```

Do not print the credentials or use MinIO root credentials in application code.
Store only the dedicated access key/secret in the worker's ignored `.env.local`
or scoped CI secrets. No provisioning command above has been executed.

On 2026-09-28 the Mac could not reach either LAN MinIO health URL. Tailscale was
running, but reported `core-01` offline; SSH to its tailnet IP and the Proxmox
host timed out. No router, host, container, or network configuration was changed.
Cloud Convex and hosted CI cannot be assumed to have access to this private
endpoint. Verify DNS/routing from the chosen worker host; CI's unit tests do not
depend on MinIO or other homelab services.

### Configure and run one source

Copy the worker variables from `.env.example` into your existing ignored
`.env.local`, preserving the personal deployment selection. Use a fine-grained
GitHub token restricted to `bmw-corpus`, with Contents read/write. Do not copy a
broad interactive `gh` credential onto a hosted service.

Prepare a JSON approval array with `origin`, segment-boundary `pathPrefix`,
`approvedBy`, `basis`, UTC `approvedAt`, and `fixture`. Keep the path narrow and
set `fixture: true` for the project-owned test page. A submission cannot create
this approval. Review the configuration, then run:

```sh
pnpm collection approval set /absolute/path/to/reviewed-approvals.json
pnpm collection config
pnpm collection doctor
pnpm collection submit --url 'https://approved.example/source' --key 'sample-001'
pnpm collection worker --job '<returned-job-id>'
pnpm collection status --job '<returned-job-id>'
```

The default fetch limits are 524,288 bytes and 15,000 ms. These are Convex
deployment settings; local worker variables do not override the server policy.
To change them on an identified personal dev deployment, announce the target
and then use explicit selection, for example:

```sh
pnpm exec convex env set COLLECTION_MAX_BYTES 524288 --deployment '<dev-name>'
pnpm exec convex env set COLLECTION_TIMEOUT_MS 15000 --deployment '<dev-name>'
pnpm collection config
```

`doctor` tests authenticated reads from the actual worker runtime without writing
probe objects. The collection itself verifies S3 staging writes and GitHub
publication. An unapproved discovery is deferred; it is not downloaded. Replaying
the same key/payload returns the same result. A known URL with a new key does not
fetch again unless `--reacquire` is explicit.

All followed redirects must remain within the same complete source approval,
including its redistribution basis and fixture label. Conflicting overlapping
approval rules are rejected. A capture already checkpointed in Convex must have
its matching S3 envelope and bytes on retry; a missing envelope fails visibly
instead of refetching under an existing capture identity.

For an ordinary failure, inspect the saved status and then run:

```sh
pnpm collection retry --job '<job-id>'
pnpm collection worker --job '<job-id>'
pnpm collection status --job '<job-id>'
```

The worker reuses a stable S3 capture envelope, original retrieval time, and raw
hash when available. Publication verifies both artifact and manifest at the
recorded immutable commit; conflicting existing files are never overwritten.
Stale worker attempts cannot complete a newer retry. Running-job recovery is
manual and requires at least fifteen minutes since the claim; stop the original
worker before recovering a stuck job. S3 retention stays `retain`. Processing
results belong to each capture and processor revision; they are recorded
separately after transformation and immutable file verification.

### Publish implementation for review

This workspace is connected to `alexcatdad/bmw-knowledge`. It began from the
existing `origin/main` README commit on branch `codex/collection-slice-1`.
Preserve local `.env.local` and generated setup skills; neither belongs in the
public repository. Commit source, lockfile, generated Convex types/guidance,
runbook, and audit decisions, then push the branch and create a draft PR using
`gh pr create --draft --body-file <reviewed-body-file>`. Attach any created PR to
the chat. Do not merge or claim the complete MVP from fixture-only checks.

The existing GitHub SSH key authenticates as `alexcatdad`; this checkout uses
`git@github.com:alexcatdad/bmw-knowledge.git` as its push URL and HTTPS for fetches.
The current `gh` OAuth token can create the PR but lacks workflow-file write
scope. The existing SSH credential published the branch without changing that
token or global credential configuration.

The implementation is open for review in draft PR
<https://github.com/alexcatdad/bmw-knowledge/pull/1>. Dedicated MinIO access and
live corpus collection remain pending; the corpus repository has not been
modified by the local tests or the developer control fixture.

### Develop deterministic normalization

The next development step uses the project-owned fixture while dedicated live
staging access is pending. Implement one shared `packages/normalization`
processor and `pnpm normalize`, then run the root typecheck/test gate. Treat
captured HTML as data: never execute scripts, fetch links, render a browser, or
extract automotive facts. Preserve input bytes and verify their declared hash.

The processor is pinned to an immutable software commit. Derived paths contain
the capture identity and processor revision; receipts record input/output hashes,
input corpus revision, processor version, fixture label, and explicit losses.
Replays must reuse identical derived bytes and the original receipt. Conflicting
files fail instead of being overwritten. Processing status belongs to each
capture/context and remains separate from acquisition/publication success.

Prepare a corpus workflow around the same CLI. Its push trigger covers captured
inputs only, excluding derived-only changes. Publish the workflow as reviewable
code before enabling it. The narrow Convex result callback must be disabled when
its dedicated machine secret is absent and must prove output files at an immutable
corpus revision before declaring success. Local fixture checks do not satisfy the
real-source or live Actions acceptance gates.

Validate development with `pnpm check` and, when available,
`actionlint .github/workflows/check.yml .github/workflows/normalize-corpus.yml`.
After committing the processor, run `pnpm normalization-smoke` from a clean
checkout. CI runs the same smoke on Node 24. It creates and removes a temporary
Git repository containing labelled synthetic inputs, calls the native CLI twice,
and checks fixed expected Markdown bytes, hashes, replay, and unchanged input.
It never publishes those synthetic captures or calls the live callback.

For an actual committed capture, use a corpus checkout at the input revision and
a clean software checkout at the declared processor revision:

```sh
pnpm normalize --corpus /absolute/path/to/bmw-corpus \
  --capture '<capture-id>' --processor-revision '<40hex-software-commit>' \
  --input-revision '<40hex-corpus-head>' --summary /private/tmp/new-processing-summary.json
```

The command reads Git blobs at that corpus commit, not mutable worktree inputs.
Input files must be regular nonexecutable blobs and manifests must use the shared
canonical serialization. `--all` processes at most 100 capture manifests;
explicit `--capture` flags select a smaller batch. Missing or corrupt raw bytes
produce per-capture failure results when the manifest identifies the input.
An unidentifiable or noncanonical manifest stops the command visibly.
Existing derived files must be identical. Source/context-specific receipts retain
their original input commit when replayed on newer corpus heads.

The reusable workflow is `.github/workflows/normalize-corpus.yml` in this
repository. Prepare the separate corpus caller from
`infra/github/corpus-normalize.yml.template`, replacing both
`PROCESSOR_COMMIT_SHA` placeholders with the tested full software commit. Keep
it on a review branch until live setup is ready. Only captures/raw pushes to
`main` trigger it; derived-only commits do not. Manual workflow dispatch provides
a processing retry. The workflow checks out the pinned tooling, installs the
frozen lockfile, calls this CLI, commits only derived outputs, and reports them
after a successful non-force push. Concurrent acquisitions are handled by at
most three fetch/rebase/push attempts; unresolved conflicts fail visibly.

When enabling processing, generate one dedicated random base64url machine secret
of at least 32 characters, saved outside Git without a trailing newline. Announce
the identified personal development target before setting its environment. Use
stdin/file input rather than putting the secret in command arguments or logs:

```sh
pnpm exec convex env set PROCESSING_CALLBACK_SECRET \
  --deployment '<personal-dev-name>' --from-file /private/path/to/processing-secret
gh secret set PROCESSING_CALLBACK_SECRET --repo alexcatdad/bmw-corpus \
  < /private/path/to/processing-secret
gh variable set PROCESSING_CALLBACK_URL --repo alexcatdad/bmw-corpus \
  --body 'https://<personal-dev-name>.convex.site/processing/result'
```

The same secret is required only on that deployment and corpus CI. The callback
is not a research credential and cannot approve sources, submit acquisition jobs,
or perform deployment administration. The CLI also removes it from its native
Convex child environment. Inspect processing through
`pnpm collection status --job '<job-id>'`; the result includes up to ten records
for that capture. Detailed deduplicated outcome events are available through the
internal `processing:getResult` maintainer function with an explicit capture and
processor revision. Failure cannot downgrade a previously verified success.

Success verification reads the exact captured manifest/raw input at the declared
input commit and the exact receipt/output at the reported result commit. Both
revisions must be full immutable Git identifiers of the configured public corpus.
Authenticated invalid or unproved results do not become processing success.
The report sender has a 60-second deadline for the four individually bounded
10-second proof reads plus database work; errors are fixed codes without SDK
bodies, secrets, or source text.

## Research interface development

Continue on the existing software review branch. The first research interface
uses internal Convex functions and one remote `/mcp` HTTP handler. Do not add a
second local MCP host, a model-backed agent, or a generic administrative tool.
The versioned instruction is `research/discovery-v1.md`.

Before changing backend code, read `convex/_generated/ai/guidelines.md` and the
existing schema. Extend populated source metadata with optional fields; preserve
CaptureManifest v1, its source snapshot, and pinned normalization behavior.
Validate with native Convex typechecking, root `pnpm check`, and official SDK
client tests against the web-standard handler. Announce the identified personal
dev deployment before any codegen, push, or environment mutation.

Research writes accept fixed schemas and application operations only:
begin/finish a run, submit a bounded discovery batch, and save a cited manual
report. An exact retry returns the original record. A changed payload using the
same key fails. All batch items and queued collection jobs commit together.
Source acquisition still requires the maintainer's separate policy; research
clients cannot approve redistribution or request reacquisition.

Use compact briefs and bounded source lookup/status results. Retain each
discovery's run and referrer metadata. Saved report Markdown and citations are
stored as `manual_research_report` / `unverified_research`, separate from capture
and corpus publication records. Reports do not acquire their cited sources or
create jobs. Scheduled discovery cannot submit interpreted manual reports.

For a developer import, use the fixed tool-name command with a JSON input file;
the same shared input contract is enforced by MCP and backend functions:

```sh
pnpm research config
pnpm research get_research_brief
pnpm research begin_research_run --input /absolute/path/to/run.json
pnpm research search_sources --input /absolute/path/to/lookup.json
pnpm research submit_discoveries --input /absolute/path/to/batch.json
pnpm research get_collection_status --input /absolute/path/to/status.json
pnpm research save_research_report --input /absolute/path/to/report.json
pnpm research get_research_report --input /absolute/path/to/report-id.json
pnpm research finish_research_run --input /absolute/path/to/outcome.json
```

`research/example-discovery.json` is a synthetic reference-only example. Replace
its run ID with the actual result from `begin_research_run`; never treat the
example URL as BMW evidence. These commands use existing native CLI login,
reject production/deployment-key overrides, and exclude worker, processing,
and research credentials from the CLI child environment.

The developer MCP credential is a dedicated random base64url secret. Keep it
out of Git, command arguments, and logs. The endpoint denies access if its
credential is absent or weak. No source approval, S3, GitHub, or processing
credential grants research-client access. Browser Origin requests require an
explicit host allowlist; do not open CORS just to test a server-side client.

For a transport acceptance test, use a short-lived dedicated secret on the
identified personal development deployment, refuse to replace an existing
credential, and remove the test secret in a `finally` cleanup. Use the official
SDK client to initialize, list all intended tools, read a brief, submit/replay
a labelled synthetic reference, save/read a labelled report, and finish the
run. Verify no capture/publication claims or acquisition jobs were invented.
Retain the run/report IDs as explicitly labelled integration test records.

ChatGPT's account connection remains a separate acceptance gate. Its official
authentication guide expects OAuth 2.1, resource metadata, PKCE, token audience
and scope verification, and a selected authorization provider. The single-owner
developer bearer test establishes SDK/Convex runtime compatibility only. Select
an existing provider or review one before adding an account, installing its
configuration, or claiming ChatGPT integration.

Current official connection procedure and authentication requirements:

- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP authentication](https://developers.openai.com/plugins/build/auth)

After OAuth is configured, connect the real endpoint in the owner's ChatGPT
developer mode and demonstrate one read and one authorized write. Manually
requested Deep Research produces a report; use a subsequent supported write
step to save it, then read it back. Preserve the actual tool results and any
client confirmation requirement. Do not describe this handoff as automatic or
create a recurring schedule from this runbook.

MinIO recovery recheck on 2026-09-28: the existing
`http://minio.home.lab:9000/minio/health/live` returned HTTP 200 from the developer
host. Added only the user-supplied endpoint, `us-east-1`, and path-style addressing
to the ignored local worker configuration; no existing values were overwritten.
Its protected backup is `/private/tmp/bmw-minio-local-env-4n5n4xoy`.
The dedicated bucket/credentials and corpus publisher credential remain absent.
No shared MinIO configuration, bucket, or identity was changed. This health
response does not demonstrate authenticated S3 object access or a cloud CI route.

Research scope lives in the optional deployment setting `RESEARCH_SCOPE_JSON`.
The default is both supported series, empty focus/body-style hints, and English
operation. A reviewed scope file can contain, for example:

```json
{"series":["E30"],"focus":["electrical documentation"],"bodyStyles":["sedan"],"operationalLanguage":"en"}
```

After announcing the identified personal dev target, set that nonsecret JSON via
stdin and verify `pnpm research config` / `get_research_brief`. Existing runs
retain the brief and scope they began with. A new run receives the current scope;
submissions must remain within its series. Invalid scope configuration fails
visibly. This initial capability supports E30 and E46; broader acquisition types
remain an expansion chosen from actual sample needs.

To exercise the real HTTP endpoint with an already configured dedicated
development credential in scoped local environment:

```sh
pnpm research-smoke
```

This command checks concurrent run/batch/report replay, changed-payload conflicts,
URL/domain/topic lookup including legacy metadata, exact saved cited Markdown, closed-run write rejection,
and current collection status through the official SDK client. It refuses any
deployment with acquisition approvals before creating persistent fixture records.
Its output contains fixture record IDs and capability checks, never the credential.
It does not set or remove credentials, create captures, or verify ChatGPT OAuth.
Remove any temporary test credential from the identified deployment after the
test, verify the endpoint returns 401 again, and retain the IDs in this audit.

Research verification on 2026-09-28:

- `pnpm check`: 176 tests across 16 files plus root TypeScript passed. Native
  Convex TypeScript and frozen pnpm install also passed.
- Native push with typechecking completed on personal dev `modest-beagle-916`.
  Function-spec contains 22 internal operations and four HTTP route entries:
  POST `/processing/result` and POST/GET/DELETE `/mcp`, using two handlers.
- Real SDK 1.30.1 initialized the remote endpoint, listed all eight tools, and
  verified concurrent/exact replay, fixed conflict codes, legacy full-text
  lookup, cited report save/read, collection status, and closed-run rejection.
  The retained successful fixture is run `kd7dthy1cygq3v1bqr6vndyq9h8f8086`,
  batch `k57f6ytdw4t2e90kgnkhw81jcs8f86r3`, source
  `jh745257g39zzjdxtcp6qrv3rh8f9ryh`, report `k97edcnwcfw22hzqqevnnhjrf98f97pm`.
- Initial smoke attempts exposed cached SDK success-schema validation of error
  `structuredContent`. Errors now omit that field and carry only fixed JSON
  `error.code` / `error.message` in text with `isError: true`; successful outputs
  keep their declared schemas. The SDK regression lists tools before exercising
  a conflict. Partial fixture runs `kd70533hecj9ys7jk6vndy1sy98f90af` and
  `kd7arn288w6jc6t88xdnv41yrs8f9sdg` were finished with that explicit outcome.
- Temporary research access was removed in `finally`. Configuration reports no
  developer credential and no ChatGPT OAuth; unauthenticated `/mcp` and processing
  callback requests return 401. The live job list remains empty.

These labelled records prove developer transport and application behavior.
Dedicated authenticated MinIO access, corpus publication/processing with a real
approved source, the owner's OAuth connection, and actual scheduling remain
unverified. No shared infrastructure or recurring task was changed.

Research implementation commit `59431ec3b009a439da1c0458b48f38ecab850e9b`
is pushed to the existing draft [software PR](https://github.com/alexcatdad/bmw-knowledge/pull/1).
Hosted Check runs [36425452128](https://github.com/alexcatdad/bmw-knowledge/actions/runs/36425452128)
and [36425443009](https://github.com/alexcatdad/bmw-knowledge/actions/runs/36425443009)
completed successfully at that exact commit. Node 24 ran all 176 tests and the
native normalization smoke; its input/output hashes match the local check.
The PR title and body now describe collection, normalization, and the research
interface together. The separate corpus caller remains pinned to its previously
verified normalization commit; research changes do not change that processor.
Both PRs remain drafts and main branches are unchanged.

## Convex acquisition runtime

FR-05 calls for acquisition through a Convex Action. `acquisition:run` is an
internal Node Action around the same collector and S3/GitHub adapters used by the
developer worker. `convex.json` pins Node 24, matching hosted validation. No new
worker service, recurring job, or acquisition implementation is introduced.

The maintainer setting `COLLECTION_EXECUTION_MODE` selects `developer` or
`convex`; its absent default is `developer`. Keep that default until the actual
cloud runtime has a route to the private MinIO endpoint and its own dedicated
application credentials. In Convex mode, source submission schedules work in the
same mutation that creates the accepted job; explicit failed/stale-attempt retry
schedules the requeued job. Exact submission replay, known/deferred leads, and
retry of an already queued job do not schedule again. Changing the mode does not
backfill earlier queued jobs.

Use these fixed developer commands with the identified personal dev deployment:

```sh
pnpm collection config
pnpm collection doctor --runtime convex
pnpm collection runtime set convex
pnpm collection submit --url '<approved-https-source>' --key '<unique-key>'
pnpm collection status --job '<returned-job-id>'
pnpm collection retry --job '<failed-job-id>'
```

Select `convex` only after the route and credentials below have been verified.
The doctor Action performs a bounded GET of the configured MinIO health endpoint;
it does not read or write objects, use credentials, grant approval, or expose
response bodies. A health response does not prove authenticated object access.

The Node Action reads worker settings from the selected deployment's typed env,
not from the local worker file. Supply a dedicated bucket, restricted S3 identity,
S3 endpoint/region/path style, and corpus-scoped publisher token through deployment
secrets. Announce the exact development target first, refuse to replace unrelated
values, and use the existing stdin/from-file env-setting procedure. Never print
secrets or put them in command arguments. Worker setting validation is shared
with the developer CLI, including reserved shared identity/bucket exclusions and
corpus target consistency.

For one existing queued job, `pnpm collection worker --job '<job-id>'` invokes the
selected runtime. An explicit `--runtime` must agree with the maintainer setting.
The Convex call waits up to nine minutes and a failed action exits nonzero with a
safe code; inspect status before retrying a lost CLI acknowledgement. Switching
back to the private developer host uses `pnpm collection runtime set developer`
and that host's scoped local credentials.

The Node Action has an eight-minute overall deadline in addition to per-request
limits. Its abort signal reaches source fetch, S3 reads/writes, GitHub requests,
and response-body reads. It awaits work and checkpoints, preserving staged bytes
for retry and reserving time to record a failure before the platform limit.
Mode changes, stale attempts, missing configuration, revoked source approval,
and lost publication acknowledgements cannot fabricate a completed capture.

The current platform limits and Node version configuration are documented in
[Convex limits](https://docs.convex.dev/production/state/limits) and
[Convex runtimes](https://docs.convex.dev/functions/runtimes).

For an actual-runtime health probe while endpoint configuration is absent:
verify `collection config` shows developer mode, no source approvals or jobs,
and no deployment S3 endpoint; temporarily set only the approved nonsecret
endpoint on that personal dev deployment; run `doctor --runtime convex`; remove
the temporary endpoint in `finally`; verify configuration and jobs are unchanged.
Stop if existing configuration would be overwritten. This probe cannot establish
FR-05 or first-source acceptance without authenticated storage/publication and
actual captured bytes.

Verification on 2026-09-28:

- Both strict TypeScript projects and all 220 tests across 19 files passed.
- Native codegen and dev push compiled the Action on `modest-beagle-916`.
  Deployed metadata lists 24 internal operations, including both acquisition
  Actions, and four HTTP route entries. Node 24 is pinned in `convex.json`.
- The actual Convex Node probe returned `PROBE_FAILED` for the approved private
  DNS address and `PROBE_TIMEOUT` for the private IP. Neither returned an HTTP
  response. MinIO health from the developer host returned HTTP 200.
- Both temporary endpoint settings were removed in `finally`; configuration was
  restored exactly, developer mode retained, and the live job list stayed empty.
  Unauthenticated MCP and processing requests still returned 401.

The acquisition Action is implemented and deployed for development. A completed
real capture through that Action remains pending until its runtime can reach
MinIO and has dedicated credentials, a corpus publisher token, and an approved
source. Authenticated object access was not exercised by the health probe.

Implementation commit `859254a54abb2f02e133e548bd960a440b0a9671` is pushed
to the existing draft software PR. Its exact-head hosted Check runs
[36428802341](https://github.com/alexcatdad/bmw-knowledge/actions/runs/36428802341)
and [36428794372](https://github.com/alexcatdad/bmw-knowledge/actions/runs/36428794372)
completed successfully. Hosted Node 24 passed all 220 tests, frozen dependency
installation, lockfile cleanliness, and native normalization replay. The clean
local and hosted fixture hashes match the values recorded above. The corpus
checkout and its pinned processor caller remain unchanged.

Acceptance recheck on 2026-09-28 at 13:34 UTC made no implementation or live
acceptance progress. Deployment and local configuration still lack the dedicated
worker/publisher access; source approvals and live jobs are empty. Research auth
reports ChatGPT OAuth and developer bearer access disabled. The available in-app
browser is signed out, and native account inspection was unavailable while the
Mac was locked. The temporary browser tab was closed without an account change.

Current [scheduled-task guidance](https://learn.chatgpt.com/docs/automations)
describes connected tools and plugins for eligible scheduled chats. It does not
prove availability or successful writes on this account. Follow the
[connection test](https://developers.openai.com/plugins/deploy/connect-chatgpt)
after the existing provider and account are available; no recurring task was
created. D-032 records the full PRD acceptance gaps and the first consecutive
blocked audit. Keep the full goal active; no new failure was found in the code.
