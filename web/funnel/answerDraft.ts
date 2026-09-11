import { validateAnswer, type ValidationResult } from '../../shared/engine';
import type { Step } from '../../shared/types';

/**
 * Validates what is on screen for a step. The engine trims number drafts, treats blank text as
 * missing, accepts only plain decimals and words every message from the step's config — the same
 * check the server runs on PUT state.
 */
export function validateDraft(step: Step, draft: string | string[]): ValidationResult {
  return validateAnswer(step, draft);
}

/** A stored number as draft text that validateDraft accepts again (String(1e-7) is "1e-7"). */
export function formatNumberDraft(n: number): string {
  const plain = String(n);
  if (!/e/i.test(plain)) return plain;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}
