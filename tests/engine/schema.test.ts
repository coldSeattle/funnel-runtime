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

type Raw = Record<string, any>;

/** Mutates a copy of a provided config and returns the issues as "dotted.path: message" lines. */
function issuesAfter(name: 'funnel-v1.json' | 'funnel-v3.json', mutate: (raw: Raw) => void): string[] {
  const raw = load(name) as Raw;
  mutate(raw);
  const res = safeParseFunnelConfig(raw);
  return res.ok ? [] : res.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}
const at = (issues: string[], path: string) => issues.filter((line) => line.startsWith(`${path}: `));

describe('funnel config schema: variant overrides are validated after merging', () => {
  it.each<[string, (raw: Raw) => void, string, RegExp?]>([
    ['a step type that does not exist', (r) => (r.experiment.variants.B.stepOverrides.intro = { type: 'banana' }), 'experiment.variants.B.stepOverrides.intro.type'],
    ['options that are not a list', (r) => (r.experiment.variants.B.stepOverrides.priorities = { input: { options: 'speed' } }), 'experiment.variants.B.stepOverrides.priorities.input.options'],
    ['a step replaced by a string', (r) => (r.experiment.variants.B.stepOverrides.intro = 'hello'), 'experiment.variants.B.stepOverrides.intro'],
    ['an info step turned into a select without input', (r) => (r.experiment.variants.B.stepOverrides.intro = { type: 'single-select' }), 'experiment.variants.B.stepOverrides.intro.input', /requires input/],
    ['a renamed step id', (r) => (r.experiment.variants.B.stepOverrides.intro = { id: 'welcome' }), 'experiment.variants.B.stepOverrides.intro.id', /must match its key/],
    ['a result step turned into an info step', (r) => (r.experiment.variants.B.stepOverrides.result = { type: 'info' }), 'experiment.variants.B.stepSequence', /exactly one result step/],
    ['result recommendations that are not a list', (r) => (r.experiment.variants.B.resultOverrides.balanced = { recommendations: 'Do less' }), 'experiment.variants.B.resultOverrides.balanced.recommendations'],
    ['a result CTA without a label', (r) => (r.experiment.variants.B.resultOverrides.balanced = { cta: { label: 42 } }), 'experiment.variants.B.resultOverrides.balanced.cta.label'],
    ['a renamed result id', (r) => (r.experiment.variants.B.resultOverrides.balanced = { id: 'other' }), 'experiment.variants.B.resultOverrides.balanced.id', /must match its key/],
  ])('rejects %s', (_label, mutate, path, message) => {
    const issues = issuesAfter('funnel-v3.json', mutate);
    expect(at(issues, path), issues.join('\n')).not.toEqual([]);
    if (message) expect(at(issues, path).some((line) => message.test(line))).toBe(true);
  });

  it('accepts overrides that only change texts, as the provided configs do', () => {
    expect(issuesAfter('funnel-v3.json', (r) => (r.experiment.variants.A.stepOverrides.team_size = { content: { title: 'Team size?' } }))).toEqual([]);
  });

  it('rejects an override that renames an answer key onto another step of the variant', () => {
    // In B meeting_hours comes before team_size; either order must be caught.
    const issues = issuesAfter('funnel-v3.json', (r) => (r.experiment.variants.B.stepOverrides.meeting_hours = { input: { name: 'team_size' } }));
    expect(at(issues, 'experiment.variants.B.stepOverrides.meeting_hours.input.name')).toEqual([
      'experiment.variants.B.stepOverrides.meeting_hours.input.name: Answer key "team_size" is already used by step "team_size"',
    ]);
  });
});

describe('funnel config schema: sessions, answer keys and conditions', () => {
  it('caps session.ttlHours at a year, so expires_at stays a valid date', () => {
    expect(at(issuesAfter('funnel-v1.json', (r) => (r.session.ttlHours = 8761)), 'session.ttlHours')).not.toEqual([]);
    expect(at(issuesAfter('funnel-v1.json', (r) => (r.session.ttlHours = 1e300)), 'session.ttlHours')).not.toEqual([]);
    expect(issuesAfter('funnel-v1.json', (r) => (r.session.ttlHours = 8760))).toEqual([]);
  });

  it('rejects two steps that store their answer under the same input name', () => {
    const issues = issuesAfter('funnel-v3.json', (r) => (r.steps.tool_count.input.name = 'team_size'));
    expect(at(issues, 'steps.tool_count.input.name')).toEqual([
      'steps.tool_count.input.name: Answer key "team_size" is already used by step "team_size"',
    ]);
  });

  it('rejects visibleWhen on an answer that comes later in one variant, naming that variant', () => {
    const issues = issuesAfter('funnel-v3.json', (r) => {
      const seq: string[] = r.experiment.variants.B.stepSequence;
      seq.splice(seq.indexOf('office_days'), 1);
      seq.splice(1, 0, 'office_days'); // office_days now precedes work_mode in B only
    });
    expect(at(issues, 'steps.office_days.visibleWhen.answer')).toEqual([
      'steps.office_days.visibleWhen.answer: In variant B, step "office_days" depends on answer "work_mode", which no earlier step of the sequence asks for',
    ]);
  });

  it('rejects visibleWhen on an answer no step asks for, or on a step that takes no answer', () => {
    for (const answer of ['ghost', 'intro']) {
      const issues = issuesAfter('funnel-v3.json', (r) => (r.steps.security_constraints.visibleWhen = { answer, operator: 'eq', value: 1 }));
      expect(at(issues, 'steps.security_constraints.visibleWhen.answer').map((l) => l.match(/variant (\w)/)?.[1])).toEqual(['A', 'B']);
    }
  });

  it('points at the offending leaf of a nested visibleWhen', () => {
    const issues = issuesAfter('funnel-v3.json', (r) => {
      r.steps.security_constraints.visibleWhen = {
        all: [
          { answer: 'priorities', operator: 'contains', value: 'compliance' },
          { answer: 'office_days', operator: 'gte', value: 1 },
        ],
      };
    });
    expect(at(issues, 'steps.security_constraints.visibleWhen.all.1.answer')).toHaveLength(2);
    expect(at(issues, 'steps.security_constraints.visibleWhen.all.0.answer')).toEqual([]);
  });

  it('reports a visibleWhen introduced by a variant override under that override', () => {
    const issues = issuesAfter('funnel-v3.json', (r) => {
      r.experiment.variants.B.stepOverrides.priorities.visibleWhen = { answer: 'office_days', operator: 'gte', value: 1 };
    });
    expect(at(issues, 'experiment.variants.B.stepOverrides.priorities.visibleWhen.answer')).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it('rejects result rules on answers that no step asks for', () => {
    const issues = issuesAfter('funnel-v3.json', (r) => {
      r.resultRules[1].when.answer = 'meeting_minutes';
      r.resultRules[0].when.all[1].answer = 'security_level';
    });
    expect(issues).toEqual([
      'resultRules.0.when.all.1.answer: Unknown answer "security_level": no step asks for it',
      'resultRules.1.when.answer: Unknown answer "meeting_minutes": no step asks for it',
    ]);
  });

  it('keeps accepting both provided configs under every new rule', () => {
    expect(issuesAfter('funnel-v1.json', () => {})).toEqual([]);
    expect(issuesAfter('funnel-v3.json', () => {})).toEqual([]);
  });
});
