import type { Answers, AnswerValue, Condition, LeafCondition } from '../types';

/**
 * Evaluates a visibility / result condition against answers.
 * A missing answer makes any leaf condition false (including neq / not_in).
 */
export function evaluateCondition(cond: Condition, answers: Answers): boolean {
  if ('any' in cond) return cond.any.some((c) => evaluateCondition(c, answers));
  if ('all' in cond) return cond.all.every((c) => evaluateCondition(c, answers));
  return evaluateLeaf(cond, answers);
}

function evaluateLeaf(cond: LeafCondition, answers: Answers): boolean {
  const answer = answers[cond.answer];
  if (answer === undefined || answer === null) return false;
  const { operator, value } = cond;
  switch (operator) {
    case 'eq':
      return isScalar(answer) && answer === value;
    case 'neq':
      return isScalar(answer) && answer !== value;
    case 'in':
      return isScalar(answer) && Array.isArray(value) && value.includes(answer);
    case 'not_in':
      return isScalar(answer) && Array.isArray(value) && !value.includes(answer);
    case 'contains':
      return Array.isArray(answer) ? answer.includes(value as string) : answer === value;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(answer);
      const b = toNumber(value);
      if (a === null || b === null) return false;
      if (operator === 'gt') return a > b;
      if (operator === 'gte') return a >= b;
      if (operator === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function isScalar(v: AnswerValue): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
