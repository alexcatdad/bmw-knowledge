import { describe, expect, it } from "vitest";
import { approvedRuleForUrl, conservativeUrlKey, isBoundedText, policyFromConfiguration, validateSourceMetadata } from "../src/policy.js";
import { approval, captureFixture, policy } from "./helpers.js";

describe("source identity and approval", () => {
  it("preserves path/query case and order while dropping fragments", () => {
    expect(conservativeUrlKey("https://EXAMPLE.COM/approved/Rear?B=2&a=1#lights"))
      .toBe("https://example.com/approved/Rear?B=2&a=1");
  });

  it("requires an exact origin and a segment boundary for the approved prefix", () => {
    expect(approvedRuleForUrl("https://example.com/approved", policy)).toEqual(approval);
    expect(approvedRuleForUrl("https://example.com/approved/rear", policy)).toEqual(approval);
    expect(approvedRuleForUrl("https://example.com/approvedly/rear", policy)).toBeNull();
    expect(approvedRuleForUrl("https://sub.example.com/approved/rear", policy)).toBeNull();
    expect(approvedRuleForUrl("https://example.com/Approved/rear", policy)).toBeNull();
  });

  it.each([
    "http://example.com/approved",
    "https://user:secret@example.com/approved",
    "https://example.com:9000/approved",
    "https://localhost/approved",
    "https://minio.home.lab:9000/approved",
    "https://machine.local/approved",
    "https://10.0.10.21/approved",
    "https://127.0.0.1/approved",
    "https://2130706433/approved",
    "https://[::1]/approved",
    "https://example.com/approved/%2e%2e/outside",
    "https://example.com/approved/a%2fb",
    "https://example.com/approved/a%5cb",
    "https://example.com/approved/%252e%252e/outside",
    "https://example.com/approved/../outside",
  ])("rejects unsafe acquisition URL %s", (url) => {
    expect(() => conservativeUrlKey(url)).toThrow();
  });

  it("validates maintainer configuration and conservative limits", () => {
    expect(policyFromConfiguration()).toEqual({ approvals: [], maxBytes: 524288, timeoutMs: 15000, maxRedirects: 3 });
    expect(policyFromConfiguration(JSON.stringify([approval]), "1048576", "30000")).toEqual({ ...policy, maxBytes: 1048576, timeoutMs: 30000 });
    expect(() => policyFromConfiguration("{not-json}")).toThrow();
    expect(() => policyFromConfiguration(JSON.stringify([{ ...approval, approvedBy: "" }]))).toThrow();
    expect(() => policyFromConfiguration(JSON.stringify([{ ...approval, origin: "https://example.com/" }]))).toThrow();
    expect(() => policyFromConfiguration(undefined, "10485761")).toThrow();
    expect(() => policyFromConfiguration(undefined, "1e5")).toThrow();
    expect(() => policyFromConfiguration(undefined, undefined, "120001")).toThrow();
    expect(() => policyFromConfiguration(undefined, "0")).toThrow();
    expect(() => policyFromConfiguration(JSON.stringify([approval, { ...approval, pathPrefix: "/approved/fixtures", fixture: false }]))).toThrow();
    expect(policyFromConfiguration(JSON.stringify([approval, approval])).approvals).toHaveLength(2);
    expect(() => policyFromConfiguration(JSON.stringify([{ ...approval, approvedAt: "2026-02-30T09:00:00.000Z" }]))).toThrow();
  });

  it("keeps pure source validation aligned to backend metadata bounds", () => {
    const source = captureFixture().manifest.source;
    expect(validateSourceMetadata({ ...source, relevance: "x".repeat(4000), title: "x".repeat(500), series: ["E30", "E46"] })).toMatchObject({ relevance: "x".repeat(4000) });
    expect(() => validateSourceMetadata({ ...source, relevance: "x".repeat(4001) })).toThrow();
    expect(() => validateSourceMetadata({ ...source, relevance: "   " })).toThrow();
    expect(() => validateSourceMetadata({ ...source, title: "bad\u0000title" })).toThrow();
    expect(() => validateSourceMetadata({ ...source, series: [] })).toThrow();
    expect(() => validateSourceMetadata({ ...source, series: ["E30", "E30"] })).toThrow();
    expect(() => conservativeUrlKey(`https://example.com/approved/${"é".repeat(500)}`)).toThrow();
    expect(isBoundedText("Romanian ă and valid 😀", 500)).toBe(true);
    expect(isBoundedText("lone surrogate \ud800", 500)).toBe(false);
  });
});
