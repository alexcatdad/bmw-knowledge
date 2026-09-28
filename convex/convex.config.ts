import { defineApp } from "convex/server";
import { v } from "convex/values";

// Native staging needs no external credentials. An empty source policy records
// references without authorizing acquisition; S3 remains an explicit fallback.
export default defineApp({
  env: {
    COLLECTION_APPROVALS_JSON: v.optional(v.string()),
    COLLECTION_MAX_BYTES: v.optional(v.string()),
    COLLECTION_TIMEOUT_MS: v.optional(v.string()),
    COLLECTION_EXECUTION_MODE: v.optional(v.string()),
    COLLECTION_STAGING_BACKEND: v.optional(v.string()),
    S3_ENDPOINT: v.optional(v.string()),
    S3_BUCKET: v.optional(v.string()),
    S3_REGION: v.optional(v.string()),
    S3_ACCESS_KEY_ID: v.optional(v.string()),
    S3_SECRET_ACCESS_KEY: v.optional(v.string()),
    S3_FORCE_PATH_STYLE: v.optional(v.string()),
    CORPUS_GITHUB_OWNER: v.optional(v.string()),
    CORPUS_GITHUB_REPO: v.optional(v.string()),
    CORPUS_GITHUB_BRANCH: v.optional(v.string()),
    CORPUS_GITHUB_TOKEN: v.optional(v.string()),
    PROCESSING_CALLBACK_SECRET: v.optional(v.string()),
    RESEARCH_MCP_SECRET: v.optional(v.string()),
    RESEARCH_SCOPE_JSON: v.optional(v.string()),
  },
});
