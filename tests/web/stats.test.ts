import { describe, expect, it } from 'vitest';
import { compareProportions, newcombeDifference, wilsonInterval } from '../../web/admin/stats';

// Hand-checkable numbers (z = 1.959964, z² = 3.841459), all differences are B − A:
//
// Wilson for x/n: centre = (p + z²/2n) / (1 + z²/n), half = z·√(p(1−p)/n + z²/4n²) / (1 + z²/n).
//   50/100 → centre 0.5, half 0.0961684 → [0.403832, 0.596168]
//   10/55  → centre 0.202591, half 0.100714 → [0.101877, 0.303305]
//   7/65   → centre 0.129584, half 0.0764296 → [0.053154, 0.206014]
//
// Newcombe hybrid score (method 10) for d = pB − pA with Wilson limits (lA, uA), (lB, uB):
//   lower = d − √((pB − lB)² + (uA − pA)²), upper = d + √((uB − pB)² + (pA − lA)²)
//   A 10/55, B 7/65: d = −0.074126 → [−0.207293, +0.052593]
//   A 50/100, B 50/100: d = 0 → ±√2 · 0.0961684 = ±0.136003
//   A 0/10 → [0, 0.277533]; B 5/10 → half 0.263406 → [0.236594, 0.763406]
//   A 0/10, B 5/10: d = 0.5 → [0.5 − √(0.263406² + 0.277533²), 0.5 + √(0.263406² + 0²)] = [0.117368, 0.763406]

describe('wilsonInterval', () => {
  it('is centred on 0.5 for 50/100', () => {
    const interval = wilsonInterval(50, 100)!;
    expect(interval.lower).toBeCloseTo(0.403832, 5);
    expect(interval.upper).toBeCloseTo(0.596168, 5);
  });

  it('pulls a small-sample rate towards 0.5 (10/55 and 7/65)', () => {
    const a = wilsonInterval(10, 55)!;
    expect(a.lower).toBeCloseTo(0.101877, 5);
    expect(a.upper).toBeCloseTo(0.303305, 5);
    const b = wilsonInterval(7, 65)!;
    expect(b.lower).toBeCloseTo(0.053154, 5);
    expect(b.upper).toBeCloseTo(0.206014, 5);
  });

  it('stays inside [0, 1] at the edges, unlike the Wald interval', () => {
    const none = wilsonInterval(0, 10)!;
    expect(none.lower).toBe(0);
    expect(none.upper).toBeCloseTo(0.277533, 5);
    const all = wilsonInterval(10, 10)!;
    expect(all.lower).toBeCloseTo(0.722467, 5);
    expect(all.upper).toBe(1);
  });

  it('matches the published value for 81/263 (Newcombe 1998a)', () => {
    const interval = wilsonInterval(81, 263)!;
    expect(interval.lower).toBeCloseTo(0.2553, 4);
    expect(interval.upper).toBeCloseTo(0.3662, 4);
  });

  it('has no interval without trials or with impossible counts', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
    expect(wilsonInterval(-1, 10)).toBeNull();
  });
});

describe('newcombeDifference', () => {
  it('gives the hybrid score interval for B − A (A 10/55, B 7/65)', () => {
    const interval = newcombeDifference({ successes: 10, trials: 55 }, { successes: 7, trials: 65 })!;
    expect(interval.lower).toBeCloseTo(-0.207293, 5);
    expect(interval.upper).toBeCloseTo(0.052593, 5);
  });

  it('is symmetric around 0 for identical arms (50/100 vs 50/100)', () => {
    const interval = newcombeDifference({ successes: 50, trials: 100 }, { successes: 50, trials: 100 })!;
    expect(interval.lower).toBeCloseTo(-0.136003, 5);
    expect(interval.upper).toBeCloseTo(0.136003, 5);
  });

  it('handles a zero arm (A 0/10, B 5/10)', () => {
    const interval = newcombeDifference({ successes: 0, trials: 10 }, { successes: 5, trials: 10 })!;
    expect(interval.lower).toBeCloseTo(0.117368, 5);
    expect(interval.upper).toBeCloseTo(0.763406, 5);
  });

  it('matches the published examples of Newcombe (1998), method 10', () => {
    // Published as p1 − p2 for 56/70 − 48/80 and 9/10 − 3/10; here A is the second arm.
    const first = newcombeDifference({ successes: 48, trials: 80 }, { successes: 56, trials: 70 })!;
    expect(first.lower).toBeCloseTo(0.0524, 4);
    expect(first.upper).toBeCloseTo(0.3339, 4);
    const second = newcombeDifference({ successes: 3, trials: 10 }, { successes: 9, trials: 10 })!;
    expect(second.lower).toBeCloseTo(0.1705, 4);
    expect(second.upper).toBeCloseTo(0.809, 4);
  });

  it('has no interval when an arm has no trials', () => {
    expect(newcombeDifference({ successes: 0, trials: 0 }, { successes: 5, trials: 10 })).toBeNull();
  });
});

describe('compareProportions', () => {
  it('calls a CI that includes 0 "no significant difference" and reports the relative lift', () => {
    const comparison = compareProportions({ successes: 10, trials: 55 }, { successes: 7, trials: 65 });
    expect(comparison.a.rate).toBeCloseTo(0.181818, 5);
    expect(comparison.b.rate).toBeCloseTo(0.107692, 5);
    expect(comparison.difference).toBeCloseTo(-0.074126, 5);
    expect(comparison.relativeLift).toBeCloseTo(-0.407692, 5);
    expect(comparison.verdict).toBe('no_difference');
  });

  it('finds no difference between identical arms', () => {
    const comparison = compareProportions({ successes: 50, trials: 100 }, { successes: 50, trials: 100 });
    expect(comparison.difference).toBe(0);
    expect(comparison.relativeLift).toBe(0);
    expect(comparison.verdict).toBe('no_difference');
  });

  it('refuses a verdict on small samples even when the CI excludes 0 (0/10 vs 5/10)', () => {
    const comparison = compareProportions({ successes: 0, trials: 10 }, { successes: 5, trials: 10 });
    expect(comparison.interval!.lower).toBeGreaterThan(0);
    expect(comparison.relativeLift).toBeNull(); // no baseline to be relative to
    expect(comparison.verdict).toBe('insufficient');
  });

  it('needs at least 30 trials and 5 successes in each arm', () => {
    expect(compareProportions({ successes: 10, trials: 29 }, { successes: 20, trials: 100 }).verdict).toBe('insufficient');
    expect(compareProportions({ successes: 20, trials: 100 }, { successes: 4, trials: 100 }).verdict).toBe('insufficient');
    expect(compareProportions({ successes: 5, trials: 30 }, { successes: 5, trials: 30 }).verdict).toBe('no_difference');
  });

  it('says B is better or worse only when the CI excludes 0', () => {
    const better = compareProportions({ successes: 20, trials: 100 }, { successes: 40, trials: 100 });
    expect(better.interval!.lower).toBeGreaterThan(0);
    expect(better.verdict).toBe('better');
    expect(better.relativeLift).toBeCloseTo(1, 10);

    const worse = compareProportions({ successes: 40, trials: 100 }, { successes: 20, trials: 100 });
    expect(worse.interval!.upper).toBeLessThan(0);
    expect(worse.verdict).toBe('worse');
    expect(worse.relativeLift).toBeCloseTo(-0.5, 10);
  });

  it('treats an empty arm as not enough data', () => {
    const comparison = compareProportions({ successes: 0, trials: 0 }, { successes: 12, trials: 80 });
    expect(comparison.a.rate).toBeNull();
    expect(comparison.difference).toBeNull();
    expect(comparison.interval).toBeNull();
    expect(comparison.verdict).toBe('insufficient');
  });
});
