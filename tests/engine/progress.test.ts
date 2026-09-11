import { describe, expect, it } from 'vitest';
import { progress, resolveVariant } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const v1 = loadConfig('funnel-v1.json');

describe('progress', () => {
  const a = resolveVariant(v1, 'A');

  it('counts only visible interactive steps', () => {
    expect(progress(a, { work_mode: 'remote' }, 'team_size')).toEqual({ index: 1, count: 6 });
    expect(progress(a, { work_mode: 'hybrid' }, 'team_size')).toEqual({ index: 1, count: 7 });
    expect(progress(a, { work_mode: 'hybrid' }, 'office_days')).toEqual({ index: 5, count: 7 });
    expect(progress(a, { work_mode: 'remote' }, 'async_maturity')).toEqual({ index: 5, count: 6 });
  });

  it('returns null for excluded step types', () => {
    expect(progress(a, {}, 'intro')).toBeNull();
    expect(progress(a, {}, 'result')).toBeNull();
  });

  it('returns null for hidden steps', () => {
    expect(progress(a, { work_mode: 'remote' }, 'office_days')).toBeNull();
  });
});
