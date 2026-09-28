# Deterministic capture normalization

`normalizeCapture({ manifest, bytes, processorRevision, inputCommitSha })` returns
derived UTF-8 bytes and a versioned processing receipt. It verifies complete
HTTP-200 capture metadata, raw SHA-256 and byte length before conversion. It never
changes input bytes, fetches linked resources, renders a browser, or extracts facts.

HTML/XHTML becomes Markdown through pinned Cheerio and Turndown versions. Links
resolve against the captured final URL or the document's first base URL when safe.
Only public HTTP/HTTPS destinations without credentials or nonstandard ports
remain links. Active elements and attributes are removed; images become alt
text when available, and table cells become separated text. Layout, linked
resources, images and table structure have explicit bounded warning codes.
Literal HTML in converted text is escaped. UTF-8 is the default; incompatible
HTTP, HTML meta or XML encoding declarations fail visibly.

Plain text and Markdown source bodies become LF text with `text/plain` output;
Markdown is labelled `markdown-treated-as-text`. Their source markup is displayed
as text rather than interpreted as active Markdown or HTML. UTF-8 BOM removal
is recorded. Output is capped at 10 MiB. No clock, random value or live request
participates in conversion.

The `./contract` export contains no Node, AWS or parser imports. Convex can use
its receipt validator, immutable path generators, warning/failure code tuples,
and stable serializers. The capture serializer has explicit v1 field order and
is checked against the collection package's published manifest serializer.

`normalized/<captureId>/<processorRevision>/document.md` (or `.txt`) contains the
derived bytes. `processing/<captureId>/<processorRevision>.json` contains the
receipt. The receipt stores the raw artifact hash, exact canonical capture
manifest hash, input corpus commit, processor revision/version, output hash and
warnings. Neither artifact content nor callers may select arbitrary paths.

Run package validation from the repository root:

```sh
pnpm --filter @bmw-knowledge/normalization typecheck
pnpm --filter @bmw-knowledge/normalization test
```
