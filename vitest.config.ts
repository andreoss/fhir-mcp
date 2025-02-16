import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    maxWorkers: 2,
    minWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/**/cli.ts"],
      thresholds: { lines: 85, functions: 85, branches: 85, statements: 85 },
      reporter: ["text-summary", "lcov"]
    }
  }
})
