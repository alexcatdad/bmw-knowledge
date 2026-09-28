import { expect, test } from "vitest";
import { parseConvexOutput } from "./cli-output.js";

test("successful null checkpoints and no-op claims survive native CLI output suppression", () => {
  expect(parseConvexOutput("")).toBeNull();
  expect(parseConvexOutput("\n")).toBeNull();
  expect(parseConvexOutput("null\n")).toBeNull();
});

test("structured native CLI results retain their types and invalid output is rejected", () => {
  expect(parseConvexOutput('{"status":"accepted","jobId":"opaque-id"}\n')).toEqual({ status: "accepted", jobId: "opaque-id" });
  expect(parseConvexOutput("[]\n")).toEqual([]);
  expect(() => parseConvexOutput("Unexpected CLI message")).toThrow();
});
