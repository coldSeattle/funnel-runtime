import type { Answers, ResolvedFunnel, ResultDef } from '../types';
import { evaluateCondition } from './conditions';
import { effectiveAnswers } from './visibility';

/**
 * First matching `resultRules` entry wins; otherwise `defaultResultId`.
 * Only answers of visible steps are considered. Results carry the variant's overrides.
 */
export function computeResult(resolved: ResolvedFunnel, answers: Answers): ResultDef {
  const effective = effectiveAnswers(resolved, answers);
  for (const rule of resolved.config.resultRules) {
    if (evaluateCondition(rule.when, effective)) {
      const result = resolved.results[rule.resultId];
      if (result) return result;
    }
  }
  const fallback = resolved.results[resolved.config.defaultResultId];
  if (!fallback) throw new Error(`Default result "${resolved.config.defaultResultId}" not found`);
  return fallback;
}
