import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only modules: erased at runtime, so it can never be "covered".
      exclude: ["src/state.ts", "src/events.ts"],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
