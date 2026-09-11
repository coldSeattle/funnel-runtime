// State of the analytics numbers on screen. DOM-free so it is unit-tested under the server tsconfig.

/** What the numbers on screen are: current, being replaced, or not to be read as current. */
export type DashboardView = 'fresh' | 'refreshing' | 'stale';

export interface DashboardViewInput {
  /** URL filter key the numbers on screen were fetched for; null before the first success. */
  shownKey: string | null;
  /** URL filter key selected now. */
  currentKey: string;
  /** A request for the current filters (or a refresh) has not settled yet. */
  loading: boolean;
  /** The most recent settled request failed — any error, a 401 included. */
  failed: boolean;
}

/**
 * Decided by what was loaded, not by the kind of error: after any failure the numbers are stale
 * (a 401 too, so a rejected token never passes old numbers off as the new slice), and so are
 * numbers fetched for other filters once nothing is loading.
 */
export function dashboardView({ shownKey, currentKey, loading, failed }: DashboardViewInput): DashboardView {
  if (failed) return 'stale';
  if (loading) return 'refreshing';
  return shownKey === currentKey ? 'fresh' : 'stale';
}

export function staleNote(shownKey: string | null, currentKey: string): string {
  return shownKey !== null && shownKey !== currentKey
    ? 'Showing the previous selection — these numbers do not match the filters above.'
    : 'Showing the last loaded numbers — they may be out of date.';
}
