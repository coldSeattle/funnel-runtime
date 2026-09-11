import { validateAnswer, type ValidationResult } from '../../shared/engine';
import type { Step } from '../../shared/types';

// Plain decimal text only: Number() alone also reads "   " as 0, "0x10" as 16 and "1e1" as 10.
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Validates what is on screen for a step. Number drafts are trimmed and must be plain decimal
 * text before the engine parses them; the engine still does the range/step checks and words
 * every message from the step's config.
 */
export function validateDraft(step: Step, draft: string | string[]): ValidationResult {
  if (step.type !== 'number' || typeof draft !== 'string') return validateAnswer(step, draft);
  const text = draft.trim();
  if (text === '') return validateAnswer(step, '');
  // NaN makes the engine answer with the config's "invalid" message.
  return validateAnswer(step, DECIMAL.test(text) ? text : Number.NaN);
}

/** A stored number as draft text that validateDraft accepts again (String(1e-7) is "1e-7"). */
export function formatNumberDraft(n: number): string {
  const plain = String(n);
  if (!/e/i.test(plain)) return plain;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
