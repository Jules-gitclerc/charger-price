import { describe, it, expect } from 'vitest';

// Vitest wiring verification. Kept permanently as the canary for
// "vitest still loads, config still parses, runner still exits 0."
// If this fails, no other test result is trustworthy.
describe('vitest', () => {
  it('runs', () => {
    expect(true).toBe(true);
  });
});
