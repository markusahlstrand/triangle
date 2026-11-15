import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The 50-byte LIKE/GLOB pattern limit a Durable Object enforces — on by default,
    // so this suite sees what production sees (test/sql-limits.test.ts proves the wiring).
    setupFiles: ['./test/setup.ts'],
  },
});
