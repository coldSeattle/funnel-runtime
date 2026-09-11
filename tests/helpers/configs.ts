import { readFileSync } from 'node:fs';
import { parseFunnelConfig } from '../../shared/schema';
import type { FunnelConfig } from '../../shared/types';

export function loadRawConfig(name: 'funnel-v1.json' | 'funnel-v3.json'): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../configs/${name}`, import.meta.url), 'utf8'));
}

export function loadConfig(name: 'funnel-v1.json' | 'funnel-v3.json'): FunnelConfig {
  return parseFunnelConfig(loadRawConfig(name));
}

/** A copy of v1 with a different version number and a visible text change, for publish/rollback tests. */
export function makeSyntheticV2(): Record<string, unknown> {
  const raw = loadRawConfig('funnel-v1.json') as Record<string, any>;
  raw.version = 2;
  raw.releaseNote = 'Synthetic v2 for tests';
  raw.steps.intro.content.title = 'Build a work model your team can follow (v2)';
  return raw;
}
