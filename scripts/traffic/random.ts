/** Seeded PRNG for reproducible traffic. mulberry32: tiny, fast, good enough for simulation. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A well-mixed 32-bit seed for stream `index` of `seed` (murmur3 finalizer), so that each
 * session gets its own stream and never inherits the draws of the sessions before it.
 */
export function deriveSeed(seed: number, index: number): number {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(index + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1) */
  next: () => number;
  chance(p: number): boolean;
  /** Uniform integer in [min, max], both inclusive */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy; the input is left untouched */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    chance: (p) => next() < p,
    int,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error('pick() needs a non-empty list');
      return items[int(0, items.length - 1)]!;
    },
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}
