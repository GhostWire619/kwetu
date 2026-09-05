import { defineConfig } from 'vite';

// Phase 0: no client entry exists yet — client/ is laid down for Phase 1.
// tools/spikes/** holds throwaway probe code (CLAUDE.md carve-out); nothing
// in src/ or client/ may import it, and the external guard below turns any
// accidental import into a loud build failure instead of a silent bundle
// inclusion.
export default defineConfig({
  build: {
    rollupOptions: {
      external: [/tools[\\/]spikes[\\/]/],
    },
  },
});
