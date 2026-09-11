import { describe, expect, it } from 'vitest';
import { allowedEvents, answerKind, filterEventProperties } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');
const v3 = loadConfig('funnel-v3.json');

describe('allowedEvents', () => {
  it('v1 has the seven base events and no recommendation_expanded', () => {
    const allowed = allowedEvents(v1);
    expect(allowed.size).toBe(7);
    expect(allowed.has('recommendation_expanded')).toBe(false);
    expect(Array.from(allowed.get('step_viewed')!)).toEqual(['step_type', 'visible_step_index', 'visible_step_count']);
  });

  it('v3 adds recommendation_expanded with its properties', () => {
    const allowed = allowedEvents(v3);
    expect(Array.from(allowed.get('recommendation_expanded')!)).toEqual(['result_id', 'action', 'source']);
  });

  it('filterEventProperties drops raw answers and unknown events', () => {
    const allowed = allowedEvents(v1);
    expect(filterEventProperties(allowed, 'answer_submitted', { answer_kind: 'single', answer: 'hybrid' })).toEqual({ answer_kind: 'single' });
    expect(filterEventProperties(allowed, 'recommendation_expanded', {})).toBeNull();
    expect(filterEventProperties(allowed, 'session_started', undefined)).toEqual({});
  });

  it('answerKind maps step types', () => {
    expect(answerKind(v1.steps.work_mode!)).toBe('single');
    expect(answerKind(v1.steps.priorities!)).toBe('multi');
    expect(answerKind(v1.steps.team_size!)).toBe('number');
    expect(answerKind(v1.steps.intro!)).toBeNull();
  });
});
