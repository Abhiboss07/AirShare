import { describe, it, expect } from "vitest";
import { computeBackoff } from "../../src/utils/async.js";
import { computeShortAuthString } from "../../src/security/sas.js";

const opts = { baseDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitter: 0 };

describe("computeBackoff", () => {
  it("grows exponentially without jitter", () => {
    expect(computeBackoff(0, opts)).toBe(1000);
    expect(computeBackoff(1, opts)).toBe(2000);
    expect(computeBackoff(2, opts)).toBe(4000);
  });

  it("caps at maxDelay", () => {
    expect(computeBackoff(20, opts)).toBe(30000);
  });

  it("stays within the jitter band", () => {
    const jittered = { ...opts, jitter: 0.2 };
    for (let i = 0; i < 50; i++) {
      const d = computeBackoff(1, jittered);
      expect(d).toBeGreaterThanOrEqual(2000 * 0.8 - 1);
      expect(d).toBeLessThanOrEqual(2000 * 1.2 + 1);
    }
  });
});

describe("computeShortAuthString", () => {
  it("is deterministic and symmetric across both peers", () => {
    const a = "AAAA";
    const b = "BBBB";
    expect(computeShortAuthString(a, b, 6)).toBe(computeShortAuthString(a, b, 6));
    expect(computeShortAuthString(a, b, 6)).toHaveLength(6);
  });

  it("differs when ephemeral keys differ", () => {
    expect(computeShortAuthString("AAAA", "BBBB", 6)).not.toBe(
      computeShortAuthString("AAAA", "CCCC", 6),
    );
  });
});
