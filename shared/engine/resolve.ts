import type { DeepPartial, FunnelConfig, ResolvedFunnel, ResultDef, Step } from '../types';

/**
 * Applies one experiment variant to a config: orders steps by the variant's
 * stepSequence and deep-merges stepOverrides / resultOverrides.
 */
export function resolveVariant(config: FunnelConfig, variant: string): ResolvedFunnel {
  const def = config.experiment.variants[variant];
  if (!def) throw new Error(`Unknown variant "${variant}"`);

  const steps: Step[] = def.stepSequence.map((id) => {
    const base = config.steps[id];
    if (!base) throw new Error(`Unknown step "${id}" in variant ${variant}`);
    const override = def.stepOverrides?.[id];
    return override ? deepMerge(base, override) : base;
  });

  const results: Record<string, ResultDef> = {};
  for (const [id, base] of Object.entries(config.results)) {
    const override = def.resultOverrides?.[id];
    results[id] = override ? deepMerge(base, override) : base;
  }

  return { variant, steps, results, config };
}

export function variantKeys(config: FunnelConfig): string[] {
  return Object.keys(config.experiment.variants);
}

/** Recursively merges plain objects; arrays and scalars from `patch` replace the base value. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
