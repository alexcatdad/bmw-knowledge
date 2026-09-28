import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";
import TurndownService from "turndown";
import { manifestBytes, sha256Bytes, validateCaptureManifest } from "@bmw-knowledge/collection";
import type { CaptureManifest } from "@bmw-knowledge/collection";
import { CAPTURE_MEDIA_TYPES, conservativeUrlKey } from "@bmw-knowledge/collection/policy";
import {
  MAX_OUTPUT_BYTES, NORMALIZATION_WARNING_CODES, normalizedPathForCapture, PROCESSOR_NAME, PROCESSOR_VERSION,
  ProcessingError, validateProcessingManifest,
} from "./contract.js";
import type { NormalizationWarningCode, ProcessingManifest, ProcessingOutputMediaType } from "./contract.js";

export * from "./contract.js";

export interface NormalizeCaptureInput {
  manifest: CaptureManifest;
  bytes: Uint8Array;
  processorRevision: string;
  inputCommitSha: string;
}

export interface NormalizedCapture {
  manifest: ProcessingManifest;
  bytes: Uint8Array;
}

function requireUtf8Encoding(contentType: string): void {
  const charsets: string[] = [];
  for (const parameter of contentType.split(";")) {
    if (!/^\s*charset(?:\s|=|$)/i.test(parameter)) continue;
    const match = parameter.match(/^\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))\s*$/i);
    if (match === null) throw new ProcessingError("UNSUPPORTED_ENCODING", "Normalization requires an unambiguous UTF-8 encoding declaration.");
    charsets.push((match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase());
  }
  if (charsets.length > 1 || charsets.some((charset) => charset !== "utf-8" && charset !== "utf8")) {
    throw new ProcessingError("UNSUPPORTED_ENCODING", "Normalization supports explicitly declared UTF-8 or UTF-8 by default.");
  }
}

function inspectHtmlEncodings($: CheerioAPI, source: string): void {
  $("meta[charset]").each((_, node) => requireUtf8Encoding(`charset=${$(node).attr("charset") ?? ""}`));
  $("meta[http-equiv]").each((_, node) => {
    if ($(node).attr("http-equiv")?.toLowerCase() === "content-type") requireUtf8Encoding($(node).attr("content") ?? "");
  });
  const declaration = source.match(/<\?xml\b[^?]*\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')[^?]*\?>/i);
  if (declaration !== null) requireUtf8Encoding(`charset=${declaration[1] ?? declaration[2] ?? ""}`);
}

function safeDocumentUrl(value: string, base: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value.trim(), base);
    if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || url.port !== "") return null;
    const checked = new URL(url.href);
    checked.protocol = "https:";
    conservativeUrlKey(checked.href);
    return url.href;
  } catch {
    return null;
  }
}

function htmlToMarkdown(source: string, manifest: CaptureManifest, warnings: Set<NormalizationWarningCode>): string {
  const $ = load(source, manifest.artifact.mediaType === "application/xhtml+xml" ? { xmlMode: true } : undefined);
  inspectHtmlEncodings($, source);
  warnings.add("layout-not-preserved");

  let base = manifest.finalUrl;
  const declaredBase = $("base[href]").first().attr("href");
  if (declaredBase !== undefined) {
    const resolvedBase = safeDocumentUrl(declaredBase, manifest.finalUrl);
    if (resolvedBase === null) warnings.add("invalid-base-ignored");
    else { base = resolvedBase; warnings.add("base-url-applied"); }
  }
  if ($("a[href],img,source,video,audio,object,embed,iframe").length > 0) warnings.add("linked-resources-not-acquired");

  const active = $("script,style,iframe,frame,frameset,object,embed,applet,template,link,input,button,select,textarea");
  if (active.length > 0) warnings.add("active-content-removed");
  active.remove();
  $("head,base,meta").remove();

  if ($("img,picture,svg,canvas,video,audio").length > 0) warnings.add("images-not-preserved");
  $("img").each((_, node) => {
    const alt = $(node).attr("alt");
    if (alt === undefined || alt.trim() === "") $(node).remove();
    else $(node).replaceWith($("<span></span>").text(`Image omitted: ${alt}`));
  });
  $("svg,canvas,video,audio,source").remove();

  $("a[href]").each((_, node) => {
    const resolved = safeDocumentUrl($(node).attr("href") ?? "", base);
    if (resolved === null) { $(node).removeAttr("href"); warnings.add("unsafe-urls-removed"); }
    else $(node).attr("href", resolved);
  });

  // Leave only safe anchor destinations; attributes never reach executable or raw HTML output.
  $("*").each((_, node) => {
    const element = $(node);
    for (const attribute of Object.keys(element.attr() ?? {})) {
      if (/^on/i.test(attribute) || attribute === "srcdoc") warnings.add("active-content-removed");
      if (!(node.type === "tag" && node.name === "a" && attribute === "href")) element.removeAttr(attribute);
    }
    element.contents().each((__, child) => { if (child.type === "comment" || child.type === "directive") $(child).remove(); });
  });
  $.root().contents().each((_, node) => { if (node.type === "comment" || node.type === "directive") $(node).remove(); });

  $("table").each((_, table) => {
    warnings.add("tables-flattened");
    const paragraphs: string[] = [];
    const caption = $(table).children("caption").html();
    if (caption !== null) paragraphs.push(`<p>${caption}</p>`);
    $(table).find("tr").each((__, row) => {
      if ($(row).closest("table")[0] !== table) return;
      const cells = $(row).children("th,td").toArray().map((cell) => $(cell).html() ?? "");
      paragraphs.push(`<p>${cells.join(" | ")}</p>`);
    });
    $(table).replaceWith(paragraphs.join("\n"));
  });

  const converter = new TurndownService({
    headingStyle: "atx", hr: "---", bulletListMarker: "-", codeBlockStyle: "fenced", fence: "```",
    emDelimiter: "_", strongDelimiter: "**", linkStyle: "inlined",
  });
  converter.addRule("safe-capture-links", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("href") !== null,
    replacement: (content, node) => {
      const url = (node.getAttribute("href") ?? "").replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
      return `[${content}](${url})`;
    },
  });
  converter.addRule("bounded-code-fence", {
    filter: "pre",
    replacement: (_, node) => {
      const content = node.textContent ?? "";
      let longestRun = 2;
      for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
      const fence = "`".repeat(longestRun + 1);
      return `\n\n${fence}\n${content.replace(/\n$/, "")}\n${fence}\n\n`;
    },
  });
  const body = $("body").length === 0 ? $.root().html() ?? "" : $("body").html() ?? "";
  let markdown = converter.turndown(body).replace(/\r\n?/g, "\n");
  if (markdown.includes("<")) { markdown = markdown.replaceAll("<", "&lt;"); warnings.add("literal-html-escaped"); }
  return markdown.length === 0 ? "" : `${markdown}\n`;
}

/** Mechanical conversion only: no network access, rendering, fact extraction, clock or random. */
export function normalizeCapture(input: NormalizeCaptureInput): NormalizedCapture {
  const declaredMediaType = input.manifest?.artifact?.mediaType;
  if (typeof declaredMediaType === "string" && !(CAPTURE_MEDIA_TYPES as readonly string[]).includes(declaredMediaType)) {
    throw new ProcessingError("UNSUPPORTED_MEDIA_TYPE", "Normalization supports captured HTML, XHTML, plain text and Markdown source bytes.");
  }
  let manifest: CaptureManifest;
  try { manifest = validateCaptureManifest(input.manifest); }
  catch { throw new ProcessingError("INVALID_CAPTURE", "Normalization requires a valid complete HTTP capture manifest."); }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength !== manifest.artifact.byteLength || sha256Bytes(input.bytes) !== manifest.artifact.sha256) {
    throw new ProcessingError("INPUT_HASH_MISMATCH", "Normalization source bytes do not match the captured artifact hash and length.");
  }
  if (!/^[a-f0-9]{40}$/.test(input.inputCommitSha)) throw new ProcessingError("INVALID_CAPTURE", "Normalization input must identify an immutable corpus commit.");
  const html = manifest.artifact.mediaType === "text/html" || manifest.artifact.mediaType === "application/xhtml+xml";
  const outputMediaType: ProcessingOutputMediaType = html ? "text/markdown" : "text/plain";
  const outputPath = normalizedPathForCapture(manifest.captureId, input.processorRevision, outputMediaType);
  requireUtf8Encoding(manifest.http.contentType);
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replace(/\r\n?/g, "\n"); }
  catch { throw new ProcessingError("UNSUPPORTED_ENCODING", "Normalization source bytes are not well-formed UTF-8."); }
  const warnings = new Set<NormalizationWarningCode>();
  if (input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf) warnings.add("utf8-bom-removed");
  if (manifest.artifact.mediaType === "text/markdown") warnings.add("markdown-treated-as-text");
  let normalized: string;
  try { normalized = html ? htmlToMarkdown(source, manifest, warnings) : source; }
  catch (error) {
    if (error instanceof ProcessingError) throw error;
    throw new ProcessingError("IO_ERROR", "Normalization could not convert the captured document.");
  }
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new ProcessingError("OUTPUT_LIMIT", "Normalized output exceeds the supported byte limit.");
  const processingManifest = validateProcessingManifest({
    schemaVersion: 1,
    kind: "normalization_result",
    captureId: manifest.captureId,
    input: {
      artifactPath: manifest.artifact.path,
      sha256: manifest.artifact.sha256,
      byteLength: manifest.artifact.byteLength,
      manifestSha256: sha256Bytes(manifestBytes(manifest)),
      commitSha: input.inputCommitSha,
    },
    processor: { name: PROCESSOR_NAME, version: PROCESSOR_VERSION, revision: input.processorRevision },
    output: { path: outputPath, sha256: sha256Bytes(bytes), byteLength: bytes.byteLength, mediaType: outputMediaType },
    fixture: manifest.fixture,
    warnings: NORMALIZATION_WARNING_CODES.filter((warning) => warnings.has(warning)),
  });
  return { manifest: processingManifest, bytes };
}
