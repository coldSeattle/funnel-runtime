import { describe, expect, it } from 'vitest';
import { validateAnswer } from '../../shared/engine';
import type { Step } from '../../shared/types';
import { formatNumberDraft, validateDraft } from '../../web/funnel/answerDraft';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');
const v3 = loadConfig('funnel-v3.json');
const step = (id: string) => v1.steps[id]!;
const optional = (id: string): Step => ({ ...step(id), validation: { ...step(id).validation, required: false } });

describe('validateDraft: number steps', () => {
  it('treats a whitespace-only draft as missing, not as 0', () => {
    expect(validateDraft(step('office_days'), '   ')).toEqual({ ok: false, message: 'Enter the expected number of office days.' });
    expect(validateDraft(v3.steps.meeting_hours!, ' \t ')).toEqual({ ok: false, message: 'Enter weekly meeting hours.' });
    // min 1: the old path said "The team must have at least one person." for three spaces
    expect(validateDraft(step('team_size'), '   ')).toEqual({ ok: false, message: 'Enter the team size.' });
    expect(validateDraft(optional('office_days'), '   ')).toEqual({ ok: true, value: undefined });
  });

  it('rejects hex, binary, octal, exponent and other non-decimal notations', () => {
    for (const raw of ['0x10', '0b1', '0o7', '1e1', '1E1', '1e+1', 'Infinity', '+5', '.5', '5.', '1 0', '2,5', '１２']) {
      expect(validateDraft(step('team_size'), raw), raw).toEqual({ ok: false, message: 'Enter a valid value.' });
    }
  });

  it('accepts plain decimal text, trimmed, and keeps the config messages for range and step', () => {
    expect(validateDraft(step('team_size'), ' 12 ')).toEqual({ ok: true, value: 12 });
    expect(validateDraft(step('office_days'), '0')).toEqual({ ok: true, value: 0 });
    expect(validateDraft(step('office_days'), '-1')).toEqual({ ok: false, message: 'Enter a value from 0 to 5.' });
    expect(validateDraft(step('team_size'), '201')).toEqual({ ok: false, message: 'For this demo, enter a value up to 200.' });
    expect(validateDraft(step('team_size'), '2.5')).toEqual({ ok: false, message: 'Enter a whole number.' });
    expect(validateDraft(step('team_size'), '')).toEqual({ ok: false, message: 'Enter the team size.' });
  });

  it('differs from the bare engine exactly where the engine is too lenient', () => {
    // If these start failing, shared/engine/validate.ts got the same fix and validateDraft can shrink.
    expect(validateAnswer(step('office_days'), '   ')).toEqual({ ok: true, value: 0 });
    expect(validateAnswer(step('team_size'), '0x10')).toEqual({ ok: true, value: 16 });
  });
});

describe('validateDraft: other steps', () => {
  it('passes select drafts through to the engine unchanged', () => {
    expect(validateDraft(step('work_mode'), 'hybrid')).toEqual({ ok: true, value: 'hybrid' });
    expect(validateDraft(step('work_mode'), '')).toEqual({ ok: false, message: "Select the team's main work mode." });
    expect(validateDraft(step('priorities'), ['speed', 'speed'])).toEqual({ ok: true, value: ['speed'] });
  });
});

describe('formatNumberDraft', () => {
  it('prefills a stored number as plain decimal text that validates again', () => {
    expect(formatNumberDraft(16)).toBe('16');
    expect(formatNumberDraft(0)).toBe('0');
    expect(formatNumberDraft(-0.5)).toBe('-0.5');
    expect(formatNumberDraft(1e-7)).toBe('0.0000001');
    expect(formatNumberDraft(1e21)).toBe('1000000000000000000000');
    const wide: Step = { ...step('team_size'), input: { name: 'x' }, validation: { required: true } };
    for (const n of [16, -0.5, 1e-7, 1e21]) {
      expect(validateDraft(wide, formatNumberDraft(n))).toEqual({ ok: true, value: n });
    }
  });
});
