import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/engine/**/*.ts'],
      exclude: ['src/engine/index.ts'],
      thresholds: {
        // R-43 / plan §16.1: the engine is where correctness lives.
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
