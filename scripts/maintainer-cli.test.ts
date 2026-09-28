import { afterEach, expect, test, vi } from "vitest";
import { nativeCliEnvironment, personalDevTarget } from "./maintainer-cli.js";

afterEach(() => vi.unstubAllEnvs());

test("native CLI children exclude all worker and application credentials while retaining deployment selection", () => {
  const source = {
    CONVEX_DEPLOYMENT: "dev:example-dev",
    S3_ENDPOINT: "http://private.example:9000",
    S3_ACCESS_KEY_ID: "dedicated-identity",
    S3_SECRET_ACCESS_KEY: "secret-s3",
    CORPUS_GITHUB_TOKEN: "secret-corpus",
    PROCESSING_CALLBACK_SECRET: "secret-processing",
    RESEARCH_MCP_SECRET: "secret-research",
    PATH: "/bin",
  };
  expect(nativeCliEnvironment(source)).toEqual({ CONVEX_DEPLOYMENT: "dev:example-dev", PATH: "/bin" });
  expect(source.RESEARCH_MCP_SECRET).toBe("secret-research");
});

test("maintainer CLI accepts personal dev only and rejects administrator overrides", () => {
  vi.stubEnv("CONVEX_DEPLOYMENT", "prod:example-prod");
  vi.stubEnv("CONVEX_DEPLOY_KEY", undefined);
  vi.stubEnv("CONVEX_SELF_HOSTED_ADMIN_KEY", undefined);
  expect(() => personalDevTarget()).toThrow("personal dev");
  vi.stubEnv("CONVEX_DEPLOYMENT", "dev:example-dev");
  expect(personalDevTarget()).toBe("example-dev");
  vi.stubEnv("CONVEX_DEPLOY_KEY", "override-secret");
  expect(() => personalDevTarget()).toThrow("Remove deployment-key overrides");
  vi.stubEnv("CONVEX_DEPLOY_KEY", undefined);
  vi.stubEnv("CONVEX_SELF_HOSTED_ADMIN_KEY", "override-secret");
  expect(() => personalDevTarget()).toThrow("Remove deployment-key overrides");
});
