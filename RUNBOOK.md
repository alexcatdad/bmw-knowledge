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
worker before recovering a stuck job. S3 retention stays `retain` and
artifact processing stays `pending` until a later transformation proves success.

### Publish implementation for review

This workspace is connected to `alexcatdad/bmw-knowledge`. It began from the
existing `origin/main` README commit on branch `codex/collection-slice-1`.
Preserve local `.env.local` and generated setup skills; neither belongs in the
public repository. Commit source, lockfile, generated Convex types/guidance,
runbook, and audit decisions, then push the branch and create a draft PR using
`gh pr create --draft --body-file <reviewed-body-file>`. Attach any created PR to
the chat. Do not merge or claim the complete MVP from fixture-only checks.
