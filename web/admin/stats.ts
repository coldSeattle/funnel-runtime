// A/B comparison math for the dashboard: pure functions, no DOM, unit-tested in tests/web/stats.test.ts.
// Differences are always B − A, so a positive number means B converts better.

/** Two-sided 95 % normal quantile. */
export const Z_95 = 1.959963984540054;

/** Below these per-arm counts the dashboard refuses to call a winner. */
export const MIN_TRIALS = 30;
export const MIN_SUCCESSES = 5;

export interface Count {
  successes: number;
  trials: number;
}

export interface Interval {
  lower: number;
  upper: number;
}

export type Verdict = 'better' | 'worse' | 'no_difference' | 'insufficient';

export interface ProportionComparison {
  a: Count & { rate: number | null };
  b: Count & { rate: number | null };
  /** pB − pA; null when an arm has no trials. */
  difference: number | null;
  /** 95 % Newcombe hybrid score interval for pB − pA. */
  interval: Interval | null;
  /** (pB − pA) / pA; null when A has no trials or no successes. */
  relativeLift: number | null;
  verdict: Verdict;
}

function isValid({ successes, trials }: Count): boolean {
  return Number.isFinite(successes) && Number.isFinite(trials) && trials > 0 && successes >= 0 && successes <= trials;
}

/**
 * Wilson score interval for one proportion. Unlike the textbook Wald interval it stays inside
 * [0, 1] and keeps sensible coverage at 0 %, 100 % and small n — which is what funnel arms look like.
 */
export function wilsonInterval(successes: number, trials: number, z = Z_95): Interval | null {
  if (!isValid({ successes, trials })) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // Exact edges: floating point would otherwise leave 1e-17 instead of 0 at p = 0.
  return {
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === trials ? 1 : Math.min(1, centre + half),
  };
}

/**
 * Newcombe's hybrid score interval (1998, method 10) for pB − pA: each arm's Wilson limits are
 * combined as the square-root sum of their distances from the point estimates.
 */
export function newcombeDifference(a: Count, b: Count, z = Z_95): Interval | null {
  const wa = wilsonInterval(a.successes, a.trials, z);
  const wb = wilsonInterval(b.successes, b.trials, z);
  if (!wa || !wb) return null;
  const pa = a.successes / a.trials;
  const pb = b.successes / b.trials;
  const difference = pb - pa;
  return {
    lower: difference - Math.sqrt((pb - wb.lower) ** 2 + (wa.upper - pa) ** 2),
    upper: difference + Math.sqrt((wb.upper - pb) ** 2 + (pa - wa.lower) ** 2),
  };
}

function hasEnoughData(count: Count): boolean {
  return count.trials >= MIN_TRIALS && count.successes >= MIN_SUCCESSES;
}

export function compareProportions(a: Count, b: Count): ProportionComparison {
  const rateA = isValid(a) ? a.successes / a.trials : null;
  const rateB = isValid(b) ? b.successes / b.trials : null;
  const difference = rateA !== null && rateB !== null ? rateB - rateA : null;
  const interval = newcombeDifference(a, b);

  let verdict: Verdict;
  if (interval === null || !hasEnoughData(a) || !hasEnoughData(b)) verdict = 'insufficient';
  else if (interval.lower > 0) verdict = 'better';
  else if (interval.upper < 0) verdict = 'worse';
  else verdict = 'no_difference';

  return {
    a: { ...a, rate: rateA },
    b: { ...b, rate: rateB },
    difference,
    interval,
    relativeLift: difference !== null && rateA !== null && rateA > 0 ? difference / rateA : null,
    verdict,
  };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  better: 'B is better',
  worse: 'B is worse',
  no_difference: 'No significant difference',
  insufficient: 'Not enough data',
};
