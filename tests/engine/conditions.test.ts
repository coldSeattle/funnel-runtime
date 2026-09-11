import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '../../shared/engine';

describe('evaluateCondition', () => {
  const answers = { work_mode: 'hybrid', priorities: ['speed', 'compliance'], meeting_hours: 15, team_size: '12' };

  it('eq / neq on scalars', () => {
    expect(evaluateCondition({ answer: 'work_mode', operator: 'eq', value: 'hybrid' }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'eq', value: 'remote' }, answers)).toBe(false);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'neq', value: 'remote' }, answers)).toBe(true);
  });

  it('in / not_in', () => {
    expect(evaluateCondition({ answer: 'work_mode', operator: 'in', value: ['hybrid', 'office'] }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'in', value: ['remote'] }, answers)).toBe(false);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'not_in', value: ['remote'] }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'in', value: 'hybrid' }, answers)).toBe(false);
  });

  it('contains on arrays and strings', () => {
    expect(evaluateCondition({ answer: 'priorities', operator: 'contains', value: 'compliance' }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'priorities', operator: 'contains', value: 'focus' }, answers)).toBe(false);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'contains', value: 'hybrid' }, answers)).toBe(true);
  });

  it('numeric comparisons, including numeric strings', () => {
    expect(evaluateCondition({ answer: 'meeting_hours', operator: 'gte', value: 15 }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'meeting_hours', operator: 'gt', value: 15 }, answers)).toBe(false);
    expect(evaluateCondition({ answer: 'meeting_hours', operator: 'lt', value: 16 }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'meeting_hours', operator: 'lte', value: 14 }, answers)).toBe(false);
    expect(evaluateCondition({ answer: 'team_size', operator: 'gte', value: 10 }, answers)).toBe(true);
    expect(evaluateCondition({ answer: 'work_mode', operator: 'gte', value: 1 }, answers)).toBe(false);
  });

  it('missing answer is false for every operator', () => {
    for (const operator of ['eq', 'neq', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte'] as const) {
      expect(evaluateCondition({ answer: 'nothing', operator, value: 'x' }, answers)).toBe(false);
    }
  });

  it('any / all compose recursively', () => {
    const cond = {
      any: [
        { all: [{ answer: 'work_mode', operator: 'eq' as const, value: 'remote' }, { answer: 'meeting_hours', operator: 'gte' as const, value: 1 }] },
        { answer: 'priorities', operator: 'contains' as const, value: 'compliance' },
      ],
    };
    expect(evaluateCondition(cond, answers)).toBe(true);
    expect(evaluateCondition({ all: [cond, { answer: 'work_mode', operator: 'eq', value: 'office' }] }, answers)).toBe(false);
  });
});
