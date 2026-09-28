import { conservativeUrlKey } from "@bmw-knowledge/collection/policy";
import type { Doc } from "./_generated/dataModel";

// The complete, separately recorded discoveries retain every submitted label.
// A source's current search document is deliberately small and bounded.
export const MAX_AGGREGATE_SOURCE_LABELS = 32;

type SearchMetadata = {
  url: string;
  title?: string;
  relevance: string;
  topics?: string[];
  bodyStyles?: string[];
  language?: string;
};

export function sourceDomain(url: string): string {
  return new URL(conservativeUrlKey(url)).hostname;
}

export function sourceIndexFields(source: SearchMetadata): { domain: string; searchText: string; searchMetadataVersion: 1 } {
  return {
    domain: sourceDomain(source.url),
    searchText: [source.title ?? "", source.relevance, ...(source.topics ?? []), ...(source.bodyStyles ?? []), source.language ?? ""].join("\n"),
    searchMetadataVersion: 1,
  };
}

export function enrichSourceMetadata(source: Doc<"sources">, discovery: { topics?: string[]; bodyStyles?: string[]; language?: string }) {
  const topics = [...new Set([...(source.topics ?? []), ...(discovery.topics ?? [])])];
  const bodyStyles = [...new Set([...(source.bodyStyles ?? []), ...(discovery.bodyStyles ?? [])])];
  const language = source.language ?? discovery.language;
  const fields = {
    topics: topics.slice(0, MAX_AGGREGATE_SOURCE_LABELS),
    bodyStyles: bodyStyles.slice(0, MAX_AGGREGATE_SOURCE_LABELS),
    ...(language !== undefined ? { language } : {}),
    metadataTruncated: source.metadataTruncated === true || topics.length > MAX_AGGREGATE_SOURCE_LABELS || bodyStyles.length > MAX_AGGREGATE_SOURCE_LABELS,
  };
  return { ...fields, ...sourceIndexFields({ ...source, ...fields }) };
}

export function preview(value: string, maximum: number): string {
  // Avoid cutting a valid UTF-16 surrogate pair at a preview boundary.
  return value.slice(0, maximum).replace(/[\uD800-\uDBFF]$/, "");
}

export function sourceSummary(source: Doc<"sources">, relevanceMaximum = 4000) {
  return {
    sourceId: source._id,
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    relevance: preview(source.relevance, relevanceMaximum),
    relevanceTruncated: source.relevance.length > relevanceMaximum,
    series: source.series,
    domain: source.domain ?? sourceDomain(source.url),
    topics: source.topics ?? [],
    bodyStyles: source.bodyStyles ?? [],
    ...(source.language !== undefined ? { language: source.language } : {}),
    metadataIndexed: source.domain !== undefined && source.searchText !== undefined && source.searchMetadataVersion === 1,
    metadataTruncated: source.metadataTruncated ?? false,
    latestJobId: source.latestJobId ?? null,
  };
}
