import { describe, expect, it } from 'vitest';
import { dashboardView, staleNote, type DashboardViewInput } from '../../web/admin/dashboardView';

const current = 'version=3';
const base: DashboardViewInput = { shownKey: current, currentKey: current, loading: false, failed: false };

describe('dashboardView', () => {
  it('is fresh when the numbers on screen were fetched for the current filters', () => {
    expect(dashboardView(base)).toBe('fresh');
  });

  it('is refreshing while a request for the current filters is pending', () => {
    expect(dashboardView({ ...base, loading: true })).toBe('refreshing');
    expect(dashboardView({ ...base, shownKey: 'version=1', loading: true })).toBe('refreshing');
  });

  it('is stale after any failed request, 401 included, even for the same filters', () => {
    expect(dashboardView({ ...base, failed: true })).toBe('stale');
  });

  it('is stale when a request under new filters failed and the previous slice is still shown', () => {
    // The 401-on-refetch case: the token was rejected after the filter change.
    expect(dashboardView({ ...base, shownKey: 'version=1', failed: true })).toBe('stale');
  });

  it('stays stale while retrying after a failure', () => {
    expect(dashboardView({ ...base, shownKey: 'version=1', loading: true, failed: true })).toBe('stale');
  });

  it('is stale whenever the shown data belongs to other filters and nothing is loading', () => {
    expect(dashboardView({ ...base, shownKey: 'version=1' })).toBe('stale');
    expect(dashboardView({ ...base, shownKey: '' })).toBe('stale');
  });
});

describe('staleNote', () => {
  it('says the numbers belong to the previous selection when the filters changed', () => {
    expect(staleNote('version=1', current)).toMatch(/previous selection/);
  });

  it('says the numbers may be out of date when the filters did not change', () => {
    expect(staleNote(current, current)).toMatch(/last loaded numbers/);
  });
});
