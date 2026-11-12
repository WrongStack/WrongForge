import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // lib-level logic only: the fold/fill rules in store.ts and the pure
    // anthropicSummary formatters. Component rendering stays untested here —
    // no DOM environment is shipped for it.
    environment: "node",
    include: ["src/lib/**/*.test.ts"],
  },
});
