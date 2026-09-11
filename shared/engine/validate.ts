import type { AnswerValue, Step } from '../types';

export type ValidationResult =
  | { ok: true; value: AnswerValue | undefined }
  | { ok: false; message: string };

const DEFAULT_MESSAGES: Record<string, string> = {
  required: 'This field is required.',
  invalid: 'Enter a valid value.',
  min: 'Value is too small.',
  max: 'Value is too large.',
  step: 'Enter a whole number.',
  minSelections: 'Choose at least one option.',
  maxSelections: 'Too many options selected.',
};

// Number() alone also reads "   " as 0, "0x10" as 16 and "1e1" as 10; answers are plain decimals.
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Validates a raw answer for a step using the step's validation block.
 * Returns the normalised value (numbers parsed, arrays de-duplicated) on success.
 */
export function validateAnswer(step: Step, raw: unknown): ValidationResult {
  const messages = step.validation?.messages ?? {};
  const msg = (key: string, fallbackKey = key) => messages[key] ?? DEFAULT_MESSAGES[fallbackKey] ?? DEFAULT_MESSAGES.invalid!;
  const required = step.validation?.required ?? false;

  switch (step.type) {
    case 'number': {
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (value === undefined || value === null || value === '') {
        return required ? { ok: false, message: msg('required') } : { ok: true, value: undefined };
      }
      const n = typeof value === 'number' ? value : typeof value === 'string' && DECIMAL.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { ok: false, message: msg('invalid') };
      const { min, max, step: increment } = step.input ?? {};
      if (min !== undefined && n < min) return { ok: false, message: msg('min') };
      if (max !== undefined && n > max) return { ok: false, message: msg('max') };
      if (increment !== undefined) {
        const q = (n - (min ?? 0)) / increment;
        if (Math.abs(q - Math.round(q)) > 1e-9) return { ok: false, message: msg('step') };
      }
      return { ok: true, value: n };
    }

    case 'single-select': {
      if (raw === undefined || raw === null || raw === '') {
        return required ? { ok: false, message: msg('required') } : { ok: true, value: undefined };
      }
      if (typeof raw !== 'string') return { ok: false, message: msg('invalid') };
      const options = step.input?.options ?? [];
      if (!options.some((o) => o.value === raw)) return { ok: false, message: msg('invalid') };
      return { ok: true, value: raw };
    }

    case 'multi-select': {
      const list = raw === undefined || raw === null || raw === '' ? [] : raw;
      if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
        return { ok: false, message: msg('invalid') };
      }
      const unique = Array.from(new Set(list as string[]));
      const options = step.input?.options ?? [];
      if (!unique.every((v) => options.some((o) => o.value === v))) return { ok: false, message: msg('invalid') };
      const minSel = step.validation?.minSelections ?? (required ? 1 : 0);
      const maxSel = step.validation?.maxSelections;
      if (unique.length === 0 && required) return { ok: false, message: msg('minSelections', 'required') };
      if (unique.length < minSel) return { ok: false, message: msg('minSelections') };
      if (maxSel !== undefined && unique.length > maxSel) return { ok: false, message: msg('maxSelections') };
      return { ok: true, value: unique };
    }

    default:
      return { ok: false, message: 'This step does not accept answers.' };
  }
}
