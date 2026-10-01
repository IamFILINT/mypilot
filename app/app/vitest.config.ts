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
      // Enforce minimum coverage thresholds for CI.
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
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
