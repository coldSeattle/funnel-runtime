import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFunnelConfig, safeParseFunnelConfig } from '../../shared/schema';

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../configs/${name}`, import.meta.url), 'utf8'));

describe('funnel config schema', () => {
  it('accepts both provided configs', () => {
    const v1 = parseFunnelConfig(load('funnel-v1.json'));
    const v3 = parseFunnelConfig(load('funnel-v3.json'));
    expect(v1.version).toBe(1);
    expect(v3.version).toBe(3);
    expect(Object.keys(v3.steps)).toContain('security_constraints');
  });

  it('rejects a sequence that references an unknown step', () => {
    const raw = load('funnel-v1.json');
    raw.experiment.variants.A.stepSequence.push('ghost');
    const res = safeParseFunnelConfig(raw);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues.some((i) => i.message.includes('ghost'))).toBe(true);
  });

  it('rejects a sequence whose last step is not the result', () => {
    const raw = load('funnel-v1.json');
    raw.experiment.variants.B.stepSequence = ['intro', 'result', 'team_size'];
    const res = safeParseFunnelConfig(raw);
    expect(res.ok).toBe(false);
  });

  it('rejects an unknown default result', () => {
    const raw = load('funnel-v1.json');
    raw.defaultResultId = 'nope';
    expect(safeParseFunnelConfig(raw).ok).toBe(false);
  });

  it('preserves unknown fields', () => {
    const raw = load('funnel-v3.json');
    raw.customField = { anything: true };
    const cfg = parseFunnelConfig(raw) as unknown as Record<string, unknown>;
    expect(cfg.customField).toEqual({ anything: true });
  });
});
