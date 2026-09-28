import { describe, expect, it, vi } from "vitest";
import { manifestBytes, sha256Bytes } from "@bmw-knowledge/collection";
import { MAX_OUTPUT_BYTES, normalizeCapture, processingManifestBytes } from "../src/index.js";
import { fixtureInput } from "./helpers.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("deterministic mechanical capture normalization", () => {
  it("produces repeatable derived bytes and receipts without changing the source", () => {
    const input = fixtureInput("<h1>BMW fixture</h1>\r\n<p>Original &amp; exact source bytes.</p>");
    const original = input.bytes.slice();
    const originalManifest = structuredClone(input.manifest);
    const first = normalizeCapture(input);
    const second = normalizeCapture(input);
    expect(text(first.bytes)).toBe("# BMW fixture\n\nOriginal & exact source bytes.\n");
    expect(second).toEqual(first);
    expect(processingManifestBytes(second.manifest)).toEqual(processingManifestBytes(first.manifest));
    expect(input.bytes).toEqual(original);
    expect(input.manifest).toEqual(originalManifest);
    expect(first.manifest.input.manifestSha256).toBe(sha256Bytes(manifestBytes(input.manifest)));
    expect(first.manifest.output.sha256).toBe(sha256Bytes(first.bytes));
    expect(first.manifest.output.byteLength).toBe(first.bytes.byteLength);
    expect(first.manifest.fixture).toBe(true);
  });

  it("rejects hash and length mismatches before conversion", () => {
    const input = fixtureInput();
    expect(() => normalizeCapture({ ...input, bytes: new Uint8Array(input.bytes.byteLength) })).toThrow(expect.objectContaining({ code: "INPUT_HASH_MISMATCH" }));
    expect(() => normalizeCapture({ ...input, bytes: input.bytes.slice(1) })).toThrow(expect.objectContaining({ code: "INPUT_HASH_MISMATCH" }));
  });

  it("requires complete captures and pinned input/processor revisions", () => {
    const input = fixtureInput();
    expect(() => normalizeCapture({ ...input, manifest: { ...input.manifest, http: { ...input.manifest.http, status: 206 } } })).toThrow(expect.objectContaining({ code: "INVALID_CAPTURE" }));
    expect(() => normalizeCapture({ ...input, processorRevision: "main" })).toThrow(expect.objectContaining({ code: "INVALID_CAPTURE" }));
    expect(() => normalizeCapture({ ...input, inputCommitSha: "main" })).toThrow(expect.objectContaining({ code: "INVALID_CAPTURE" }));
    expect(() => normalizeCapture(fixtureInput("PDF bytes", "application/pdf"))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_MEDIA_TYPE" }));
  });

  it("resolves relative links against the captured redirect destination", () => {
    const input = fixtureInput('<p><a href="./wires.html">Rear wiring</a> <a href="#connector">Connector</a></p>');
    input.manifest.finalUrl = "https://example.com/manuals/actual.html";
    input.manifest.redirects = [input.manifest.finalUrl];
    const output = text(normalizeCapture(input).bytes);
    expect(output).toContain("[Rear wiring](https://example.com/manuals/wires.html)");
    expect(output).toContain("[Connector](https://example.com/manuals/actual.html#connector)");
    expect(output).not.toContain("https://example.com/wires.html");
  });

  it("honors a safe HTML base and preserves links to unacquired attachments", () => {
    const input = fixtureInput('<html><head><base href="../assets/"></head><body><a href="wires(1).pdf">Wiring PDF</a></body></html>');
    input.manifest.finalUrl = "https://example.com/manuals/actual.html";
    input.manifest.redirects = [input.manifest.finalUrl];
    const result = normalizeCapture(input);
    expect(text(result.bytes)).toContain("[Wiring PDF](https://example.com/assets/wires%281%29.pdf)");
    expect(result.manifest.warnings).toEqual(expect.arrayContaining(["base-url-applied", "linked-resources-not-acquired", "layout-not-preserved"]));
  });

  it("ignores an unsafe first base instead of inheriting its URL scheme", () => {
    const input = fixtureInput('<base href="javascript:alert(1)"><base href="https://other.example.com/"><a href="wires.html">Wiring</a>');
    const result = normalizeCapture(input);
    expect(text(result.bytes)).toContain("[Wiring](https://example.com/wires.html)");
    expect(result.manifest.warnings).toContain("invalid-base-ignored");
    expect(text(result.bytes)).not.toContain("other.example.com");
  });

  it("removes active HTML, dangerous links and attributes without making requests", () => {
    const remote = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Normalization must not fetch."); });
    try {
      const input = fixtureInput('<style>.hidden{display:none}</style><script>fetch("https://evil.example.com")</script><iframe src="https://evil.example.com"></iframe><p onclick="steal()">Visible text</p><a href="javascript:alert(1)">Bad scheme</a><a href="data:text/html,evil">Data link</a><a href="https://secret:password@example.com/x">Credentials link</a><a href="http://127.0.0.1:9000">Local service</a><a href="&#x6a;avascript:alert(2)">Encoded scheme</a><p>&lt;script&gt;literal text&lt;/script&gt;</p>');
      const result = normalizeCapture(input);
      const output = text(result.bytes);
      expect(output).toContain("Visible text");
      expect(output).toContain("Bad scheme");
      expect(output).toContain("&lt;script>literal text&lt;/script>");
      expect(output).not.toMatch(/<script|javascript:|data:text\/html|127\.0\.0\.1|secret:password|steal\(\)|fetch\(|display:none/);
      expect(result.manifest.warnings).toEqual(expect.arrayContaining(["active-content-removed", "unsafe-urls-removed", "literal-html-escaped"]));
      expect(remote).not.toHaveBeenCalled();
    } finally { remote.mockRestore(); }
  });

  it("retains alt text and readable table cells while declaring structural losses", () => {
    const result = normalizeCapture(fixtureInput('<img src="diagram.png" alt="Connector diagram"><table><caption>Wire colors</caption><tr><th>Left</th><th>Right</th></tr><tr><td>Brown</td><td>Black</td></tr></table>'));
    const output = text(result.bytes);
    expect(output).toContain("Image omitted: Connector diagram");
    expect(output).toContain("Wire colors");
    expect(output).toContain("Left | Right");
    expect(output).toContain("Brown | Black");
    expect(output).not.toContain("![");
    expect(output).not.toContain("diagram.png");
    expect(result.manifest.warnings).toEqual(expect.arrayContaining(["images-not-preserved", "tables-flattened", "layout-not-preserved", "linked-resources-not-acquired"]));
  });

  it("uses code fences longer than source backtick runs", () => {
    const result = normalizeCapture(fixtureInput('<pre><code>```\n[not a link](javascript:alert(1))\n```</code></pre>'));
    expect(text(result.bytes)).toBe("````\n```\n[not a link](javascript:alert(1))\n```\n````\n");
  });

  it("supports UTF-8 by default and records BOM removal", () => {
    const utf8 = fixtureInput("Wiring ă 😀\r\nRear\rFront", "text/plain");
    utf8.manifest.http.contentType = "text/plain";
    expect(text(normalizeCapture(utf8).bytes)).toBe("Wiring ă 😀\nRear\nFront");
    const bom = fixtureInput(new Uint8Array([0xef, 0xbb, 0xbf, 65, 13, 10]), "text/plain");
    const result = normalizeCapture(bom);
    expect(text(result.bytes)).toBe("A\n");
    expect(result.manifest.warnings).toEqual(["utf8-bom-removed"]);
  });

  it.each(["iso-8859-1", "windows-1252", "utf-16", '"utf-8"; charset=utf-8', "utf-8 malformed"])("rejects unsupported or ambiguous HTTP charset %s", (charset) => {
    const input = fixtureInput();
    input.manifest.http.contentType = `text/html; charset=${charset}`;
    expect(() => normalizeCapture(input)).toThrow(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
  });

  it("rejects incompatible HTML/XML declarations and invalid UTF-8 bytes", () => {
    expect(() => normalizeCapture(fixtureInput('<meta charset="windows-1252"><p>ASCII still has an incompatible declaration.</p>'))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
    expect(() => normalizeCapture(fixtureInput('<?xml version="1.0" encoding="ISO-8859-1"?><p>Text</p>', "application/xhtml+xml"))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
    expect(() => normalizeCapture(fixtureInput(new Uint8Array([0xc3, 0x28]), "text/plain"))).toThrow(expect.objectContaining({ code: "UNSUPPORTED_ENCODING" }));
  });

  it("processes XHTML and keeps Markdown input as LF text", () => {
    const xhtml = normalizeCapture(fixtureInput('<?xml version="1.0" encoding="UTF-8"?><html><body><h2>Rear lights</h2><p><a href="/wires">Wires</a></p></body></html>', "application/xhtml+xml"));
    expect(text(xhtml.bytes)).toContain("## Rear lights");
    expect(xhtml.manifest.output.mediaType).toBe("text/markdown");
    const markdown = normalizeCapture(fixtureInput("# Source\r\n<script>display as text</script>\r", "text/markdown"));
    expect(text(markdown.bytes)).toBe("# Source\n<script>display as text</script>\n");
    expect(markdown.manifest.output.path).toMatch(/document\.txt$/);
    expect(markdown.manifest.output.mediaType).toBe("text/plain");
    expect(markdown.manifest.warnings).toEqual(["markdown-treated-as-text"]);
  });

  it("retains separate source contexts when identical HTML bytes resolve different links", () => {
    const first = fixtureInput('<a href="wires.html">Wires</a>');
    const second = { ...first, manifest: structuredClone(first.manifest) };
    second.manifest.captureId = "capture-2";
    second.manifest.source.id = "source-2";
    second.manifest.source.url = "https://example.com/other/start";
    second.manifest.requestedUrl = second.manifest.source.url;
    second.manifest.finalUrl = second.manifest.source.url;
    const firstOutput = normalizeCapture(first);
    const secondOutput = normalizeCapture(second);
    expect(firstOutput.manifest.input.sha256).toBe(secondOutput.manifest.input.sha256);
    expect(firstOutput.manifest.input.manifestSha256).not.toBe(secondOutput.manifest.input.manifestSha256);
    expect(firstOutput.manifest.output.sha256).not.toBe(secondOutput.manifest.output.sha256);
    expect(firstOutput.manifest.output.path).not.toBe(secondOutput.manifest.output.path);
  });

  it("rejects output expansion beyond the fixed processor limit", () => {
    const input = fixtureInput(`<p>${"*".repeat(MAX_OUTPUT_BYTES / 2 + 1024)}</p>`);
    expect(() => normalizeCapture(input)).toThrow(expect.objectContaining({ code: "OUTPUT_LIMIT" }));
  });
});
