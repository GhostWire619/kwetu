import { describe, it, expect } from 'vitest';

// Phase-0 toolchain smoke: proves `npm test` (vitest run, node environment)
// is wired. Delete-worthy the moment real tests exist, but it guards the
// harness itself.
describe('phase-0 harness', () => {
  it('runs tests at all', () => {
    expect(1 + 1).toBe(2);
  });
});
