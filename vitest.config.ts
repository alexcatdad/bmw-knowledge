import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["convex/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    restoreMocks: true,
  },
});
