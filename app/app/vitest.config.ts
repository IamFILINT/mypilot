/**
 * Vitest configuration for Track H unit tests.
 * Runs unit tests only (no Electron dependency).
 *
 * Run: npx vitest run
 * Watch: npx vitest
 * Coverage: npx vitest run --coverage
 *
 * Track H owns this file.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'unit',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/unit/**/*.spec.{ts,tsx}',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['tests/e2e/**', 'tests/parity/**'],
    // Renderer .spec.tsx files declare jsdom via the per-file
    //   // @vitest-environment jsdom
    // pragma. The default is node so the existing pure-unit suite is unaffected.
    environment: 'node',
    globals: false,
    // Mock electron module so tests run outside Electron
    alias: {
      '@': path.resolve(__dirname, 'src'),
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
    coverage: {
      provider: 'v8',
      include: [
        'src/main/**/*.ts',
        'src/shared/**/*.ts',
        'src/renderer/**/*.ts',
        'src/renderer/**/*.tsx',
        'config/*.ts',
      ],
      exclude: [
        '**/*.d.ts',
        '**/__mocks__/**',
        'src/renderer/**/main.tsx',
      ],
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: 'tests/results/coverage',
      // Regression gate, not a target. These sit just under the measured
      // baseline (39.73 / 38.28 / 33.31 / 37.77) so CI fails when coverage
      // drops, and passes when it rises. Do not raise them speculatively:
      // the previous 60/60/50/60 was guessed, never measured, and made the
      // unit job permanently red, which trains people to ignore it. Raise
      // these only as part of a commit that also adds the tests.
      thresholds: {
        lines: 39,
        functions: 38,
        branches: 33,
        statements: 37,
      },
    },
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      electron: path.resolve(__dirname, 'tests/fixtures/electron-mock.ts'),
    },
  },
});
