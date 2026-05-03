import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Vitest config — Prix-Bornes
//
// Scope (T09): unit tests for pure TS modules under src/lib/. No jsdom,
// no DB, no Next.js runtime — keep tests fast and side-effect-free.
// Wider scope (E2E, component tests) is M1.5+ and will land its own
// config (likely Playwright in a separate file).
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/**/*.test.ts',
    ],
    exclude: ['node_modules/**', '.next/**', 'dist/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
