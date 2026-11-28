import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // lib-level logic (node) + component rendering (happy-dom). Component
    // tests cover the state-dependent rendering the build can't typecheck;
    // src/App*.test.tsx covers the shell itself.
    environment: "happy-dom",
    globals: true,
    include: ["src/lib/**/*.test.ts", "src/components/**/*.test.tsx", "src/*.test.tsx"],
  },
});
