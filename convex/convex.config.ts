import { defineApp } from "convex/server";
import { v } from "convex/values";

// Optional until the maintainer wires a dedicated staging bucket and a source
// approval. An empty policy records references without authorizing acquisition.
export default defineApp({
  env: {
    COLLECTION_APPROVALS_JSON: v.optional(v.string()),
    COLLECTION_MAX_BYTES: v.optional(v.string()),
    COLLECTION_TIMEOUT_MS: v.optional(v.string()),
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
  },
});
