import { describe, expect, it } from 'vitest';
import type { Totals } from '../../shared/api';
import { groupVariants } from '../../web/admin/variantGroups';

function totals(started: number, ctaClicked: number): Totals {
  const reachedResult = Math.round(started * 0.6);
  return {
    started,
    reachedResult,
    ctaClicked,
    ctr: reachedResult === 0 ? null : ctaClicked / reachedResult,
    primary: started === 0 ? null : ctaClicked / started,
  };
}

// v1 and v3 run different experiments; v2 had no experiment (A only). Keys arrive unsorted, as JSON objects may.
const byVersionVariant = {
  '3': { B: totals(80, 20), A: totals(90, 9) },
  '10': { A: totals(40, 4), B: totals(41, 8) },
  '1': { B: totals(60, 6), A: totals(70, 14) },
  '2': { A: totals(30, 3) },
};

describe('groupVariants with a version filter', () => {
  it("uses only that version's variants for the rows and the comparison", () => {
    const grouping = groupVariants({ filters: { version: 3 }, byVersionVariant });
    expect(grouping.perVersion).toBe(false);
    expect(grouping.rows.map((row) => row.label)).toEqual(['Variant A', 'Variant B']);
    expect(grouping.rows.map((row) => row.totals)).toEqual([byVersionVariant['3'].A, byVersionVariant['3'].B]);
    expect(grouping.experiments).toEqual([{ version: 3, a: byVersionVariant['3'].A, b: byVersionVariant['3'].B }]);
  });

  it('has no comparison when that version has only one variant', () => {
    const grouping = groupVariants({ filters: { version: 2 }, byVersionVariant });
    expect(grouping.rows.map((row) => row.label)).toEqual(['Variant A']);
    expect(grouping.experiments).toEqual([]);
  });

  it('is empty when the version has no sessions in the slice', () => {
    const grouping = groupVariants({ filters: { version: 7 }, byVersionVariant });
    expect(grouping.rows).toEqual([]);
    expect(grouping.experiments).toEqual([]);
  });
});

describe('groupVariants across all versions', () => {
  it('lists a row per version and variant, versions in numeric order', () => {
    const grouping = groupVariants({ filters: {}, byVersionVariant });
    expect(grouping.perVersion).toBe(true);
    expect(grouping.rows.map((row) => row.label)).toEqual([
      'v1 · A',
      'v1 · B',
      'v2 · A',
      'v3 · A',
      'v3 · B',
      'v10 · A',
      'v10 · B',
    ]);
    expect(new Set(grouping.rows.map((row) => row.key)).size).toBe(grouping.rows.length);
    expect(grouping.rows[1]!.totals).toBe(byVersionVariant['1'].B);
  });

  it('compares A and B within each version that has both, never pooled across versions', () => {
    const grouping = groupVariants({ filters: {}, byVersionVariant });
    expect(grouping.experiments).toEqual([
      { version: 1, a: byVersionVariant['1'].A, b: byVersionVariant['1'].B },
      { version: 3, a: byVersionVariant['3'].A, b: byVersionVariant['3'].B },
      { version: 10, a: byVersionVariant['10'].A, b: byVersionVariant['10'].B },
    ]);
  });

  it('has no comparison when the variant filter leaves one arm per version', () => {
    const onlyA = { '1': { A: totals(70, 14) }, '3': { A: totals(90, 9) } };
    const grouping = groupVariants({ filters: { variant: 'A' }, byVersionVariant: onlyA });
    expect(grouping.rows.map((row) => row.label)).toEqual(['v1 · A', 'v3 · A']);
    expect(grouping.experiments).toEqual([]);
  });

  it('is empty when nothing matches the filters', () => {
    expect(groupVariants({ filters: {}, byVersionVariant: {} })).toEqual({ perVersion: true, rows: [], experiments: [] });
  });
});
