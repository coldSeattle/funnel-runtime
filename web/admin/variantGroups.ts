// Groups the analytics variant totals into comparable experiments. DOM-free so it is unit-tested
// under the server tsconfig (tests/web/variantGroups.test.ts).
//
// Variant keys only mean something inside one version: v1 and v3 run different experiments, so
// "A" in v1 and "A" in v3 are different arms. byVariant pools them across versions; this reads
// byVersionVariant instead and never compares arms from different versions.
import type { AnalyticsResponse, Totals } from '../../shared/api';

export interface VariantRow {
  key: string;
  label: string;
  totals: Totals;
}

/** One A/B experiment: variants A and B of a single version. */
export interface Experiment {
  version: number;
  a: Totals;
  b: Totals;
}

export interface VariantGrouping {
  /** No version filter: rows and experiments are split per version. */
  perVersion: boolean;
  rows: VariantRow[];
  /** One per version in the slice that has both A and B, ascending by version. */
  experiments: Experiment[];
}

const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

export function groupVariants(data: Pick<AnalyticsResponse, 'filters' | 'byVersionVariant'>): VariantGrouping {
  const selected = data.filters.version;
  const perVersion = selected === undefined;
  const versions = perVersion
    ? Object.keys(data.byVersionVariant).sort(byKey)
    : [String(selected)].filter((version) => Object.hasOwn(data.byVersionVariant, version));

  const rows: VariantRow[] = [];
  const experiments: Experiment[] = [];
  for (const version of versions) {
    const variants = data.byVersionVariant[version] ?? {};
    for (const variant of Object.keys(variants).sort(byKey)) {
      rows.push({
        key: `${version}:${variant}`,
        label: perVersion ? `v${version} · ${variant}` : `Variant ${variant}`,
        totals: variants[variant]!,
      });
    }
    const { A: a, B: b } = variants;
    if (a && b) experiments.push({ version: Number(version), a, b });
  }
  return { perVersion, rows, experiments };
}
