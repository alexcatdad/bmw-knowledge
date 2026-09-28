import { ConvexError } from "convex/values";
import { env } from "./_generated/server";

/** Repository selection comes only from deployment configuration. */
export function corpusTarget() {
  const owner = env.CORPUS_GITHUB_OWNER ?? "alexcatdad";
  const repo = env.CORPUS_GITHUB_REPO ?? "bmw-corpus";
  const branch = env.CORPUS_GITHUB_BRANCH ?? "main";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo === "." || repo === "..") {
    throw new ConvexError({ code: "INVALID_CORPUS_CONFIGURATION", message: "The corpus owner and repository must be valid GitHub names." });
  }
  if (branch.length === 0 || branch.length > 200 || !/^[A-Za-z0-9_/-]+$/.test(branch) || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) {
    throw new ConvexError({ code: "INVALID_CORPUS_CONFIGURATION", message: "The corpus branch must be an explicit bounded branch name." });
  }
  return { owner, repo, branch };
}
