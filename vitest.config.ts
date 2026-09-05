import { defineConfig } from 'vitest/config';

// Minimal Phase-0 harness. The default include pattern (**/*.test.ts) covers
// src/, tests/ AND tools/spikes/ — so throwaway probes run in the same
// environment via `npx vitest run tools/spikes` without a named script
// (CLAUDE.md: no spike scripts before Phase 1).
export default defineConfig({
  test: {
    environment: 'node',
  },
});
