import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'web/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['web/**', 'jsdom']],
  },
});
