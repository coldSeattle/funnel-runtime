import { describe, expect, it } from 'vitest';
import { validateAnswer } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');
const step = (id: string) => v1.steps[id]!;

describe('validateAnswer', () => {
  it('number: required, min, max, integer step, string input', () => {
    expect(validateAnswer(step('team_size'), '')).toEqual({ ok: false, message: 'Enter the team size.' });
    expect(validateAnswer(step('team_size'), 0)).toEqual({ ok: false, message: 'The team must have at least one person.' });
    expect(validateAnswer(step('team_size'), 201)).toEqual({ ok: false, message: 'For this demo, enter a value up to 200.' });
    expect(validateAnswer(step('team_size'), 2.5)).toEqual({ ok: false, message: 'Enter a whole number.' });
    expect(validateAnswer(step('team_size'), 'abc')).toEqual({ ok: false, message: 'Enter a valid value.' });
    expect(validateAnswer(step('team_size'), '12')).toEqual({ ok: true, value: 12 });
    expect(validateAnswer(step('office_days'), 0)).toEqual({ ok: true, value: 0 });
  });

  it('single-select: required and option membership', () => {
    expect(validateAnswer(step('work_mode'), undefined)).toEqual({ ok: false, message: "Select the team's main work mode." });
    expect(validateAnswer(step('work_mode'), 'moon')).toEqual({ ok: false, message: 'Enter a valid value.' });
    expect(validateAnswer(step('work_mode'), 'hybrid')).toEqual({ ok: true, value: 'hybrid' });
  });

  it('multi-select: min/max selections, de-duplication, option membership', () => {
    expect(validateAnswer(step('priorities'), [])).toEqual({ ok: false, message: 'Choose at least one priority.' });
    expect(validateAnswer(step('priorities'), ['speed', 'focus', 'cost', 'culture'])).toEqual({ ok: false, message: 'Choose no more than three priorities.' });
    expect(validateAnswer(step('priorities'), ['speed', 'speed'])).toEqual({ ok: true, value: ['speed'] });
    expect(validateAnswer(step('priorities'), ['speed', 'nope'])).toEqual({ ok: false, message: 'Enter a valid value.' });
    expect(validateAnswer(step('priorities'), 'speed')).toEqual({ ok: false, message: 'Enter a valid value.' });
  });

  it('info and result steps accept no answers', () => {
    expect(validateAnswer(step('intro'), 'x').ok).toBe(false);
    expect(validateAnswer(step('result'), 'x').ok).toBe(false);
  });
});
