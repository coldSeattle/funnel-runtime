import { describe, expect, it } from 'vitest';
import { effectiveAnswers, nextStepId, prevStepId, resolveCurrentStep, resolveVariant, visibleSteps } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');
const v3 = loadConfig('funnel-v3.json');
const ids = (steps: { id: string }[]) => steps.map((s) => s.id);

describe('resolveVariant', () => {
  it('orders steps by the variant sequence and applies overrides', () => {
    const a = resolveVariant(v1, 'A');
    const b = resolveVariant(v1, 'B');
    expect(ids(a.steps)).toEqual(['intro', 'team_size', 'work_mode', 'priorities', 'timezone_span', 'office_days', 'async_maturity', 'tool_count', 'result']);
    expect(ids(b.steps)[1]).toBe('work_mode');
    expect(b.steps[0]!.content.title).toBe('How should your team really work?');
    expect(a.steps[0]!.content.title).toBe('Build a work model your team can actually follow');
    expect(b.results.async_native!.title).toBe('Your team is ready to reduce meetings');
    expect(b.results.async_native!.summary).toBe(a.results.async_native!.summary);
    expect(b.results.async_native!.cta.label).toBe('See the 30-day action list');
  });

  it('throws for an unknown variant', () => {
    expect(() => resolveVariant(v1, 'C')).toThrow(/Unknown variant/);
  });
});

describe('visibleSteps (v1, variant A)', () => {
  const a = resolveVariant(v1, 'A');

  it('hides office_days for remote teams and shows it for hybrid', () => {
    expect(ids(visibleSteps(a, { work_mode: 'remote' }))).not.toContain('office_days');
    expect(ids(visibleSteps(a, { work_mode: 'hybrid' }))).toContain('office_days');
    expect(ids(visibleSteps(a, {}))).not.toContain('office_days');
  });

  it('drops answers of hidden steps from effectiveAnswers', () => {
    const answers = { work_mode: 'remote', office_days: 3, team_size: 5 };
    expect(effectiveAnswers(a, answers)).toEqual({ work_mode: 'remote', team_size: 5 });
  });

  it('nextStepId / prevStepId skip hidden steps', () => {
    expect(nextStepId(a, { work_mode: 'remote' }, 'timezone_span')).toBe('async_maturity');
    expect(nextStepId(a, { work_mode: 'office' }, 'timezone_span')).toBe('office_days');
    expect(prevStepId(a, { work_mode: 'remote' }, 'async_maturity')).toBe('timezone_span');
    expect(prevStepId(a, {}, 'intro')).toBeNull();
    expect(nextStepId(a, {}, 'result')).toBeNull();
  });

  it('resolveCurrentStep falls back to the previous visible step', () => {
    expect(resolveCurrentStep(a, { work_mode: 'remote' }, 'office_days').id).toBe('timezone_span');
    expect(resolveCurrentStep(a, {}, null).id).toBe('intro');
    expect(resolveCurrentStep(a, {}, 'ghost').id).toBe('intro');
    expect(resolveCurrentStep(a, { work_mode: 'hybrid' }, 'office_days').id).toBe('office_days');
  });
});

describe('visibleSteps (v3)', () => {
  it('shows security_constraints only when compliance is a priority', () => {
    const a = resolveVariant(v3, 'A');
    expect(ids(visibleSteps(a, { priorities: ['speed'] }))).not.toContain('security_constraints');
    expect(ids(visibleSteps(a, { priorities: ['speed', 'compliance'] }))).toContain('security_constraints');
  });

  it('variant B has no tool_count step', () => {
    const b = resolveVariant(v3, 'B');
    expect(ids(b.steps)).not.toContain('tool_count');
    expect(ids(b.steps)).toContain('meeting_hours');
  });
});
