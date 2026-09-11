import { describe, expect, it } from 'vitest';
import { computeResult, resolveVariant } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');
const v3 = loadConfig('funnel-v3.json');

describe('computeResult (v1)', () => {
  const a = resolveVariant(v1, 'A');

  it('remote + wide timezone → async_native', () => {
    expect(computeResult(a, { work_mode: 'remote', timezone_span: 'wide' }).id).toBe('async_native');
  });
  it('high async maturity alone → async_native', () => {
    expect(computeResult(a, { work_mode: 'office', async_maturity: 'high' }).id).toBe('async_native');
  });
  it('hybrid → hybrid_structured, office → office_core', () => {
    expect(computeResult(a, { work_mode: 'hybrid', timezone_span: 'same' }).id).toBe('hybrid_structured');
    expect(computeResult(a, { work_mode: 'office', async_maturity: 'low' }).id).toBe('office_core');
  });
  it('nothing matches → default balanced', () => {
    expect(computeResult(a, { work_mode: 'remote', timezone_span: 'same', async_maturity: 'low' }).id).toBe('balanced');
    expect(computeResult(a, {}).id).toBe('balanced');
  });
  it('variant B result carries overrides', () => {
    const b = resolveVariant(v1, 'B');
    const r = computeResult(b, { work_mode: 'hybrid' });
    expect(r.title).toBe('Your hybrid model needs clearer rules');
    expect(r.cta.label).toBe('See the 30-day action list');
    expect(r.recommendations.length).toBe(3);
  });
});

describe('computeResult (v3)', () => {
  const a = resolveVariant(v3, 'A');

  it('compliance + strict wins over meeting-heavy', () => {
    const r = computeResult(a, { priorities: ['compliance'], security_constraints: 'strict', meeting_hours: 30 });
    expect(r.id).toBe('regulated_scale');
  });
  it('meeting_hours ≥ 15 → meeting_heavy before work-mode rules', () => {
    expect(computeResult(a, { work_mode: 'hybrid', meeting_hours: 15 }).id).toBe('meeting_heavy');
    expect(computeResult(a, { work_mode: 'hybrid', meeting_hours: 14 }).id).toBe('hybrid_structured');
  });
  it('hidden security_constraints answer is ignored', () => {
    const r = computeResult(a, { priorities: ['speed'], security_constraints: 'regulated', work_mode: 'office', meeting_hours: 2 });
    expect(r.id).toBe('office_core');
  });
});
