import type { StepRow, Totals } from '../../shared/api';
import type { StepType } from '../../shared/types';

/** The event columns analytics needs; see docs/design.md §8. */
export interface AggregateEvent {
  session_id: string;
  name: string;
  step_id: string | null;
  client_timestamp: string;
  server_timestamp: string;
  variant: string;
  funnel_version: number;
}

export interface StepOrderEntry {
  stepId: string;
  type: StepType | null;
}

export interface AggregateResult {
  totals: Totals;
  steps: StepRow[];
  exitsBeforeFirstStep: number;
  byVariant: Record<string, Totals>;
  byVersion: Record<string, Totals>;
}

interface Funnel {
  started: Set<string>;
  reachedResult: Set<string>;
  ctaClicked: Set<string>;
}

interface LastView {
  stepId: string;
  client: number;
  server: number;
}

/**
 * Pure: counts unique sessions per metric, never events. Duplicated views, out-of-order
 * delivery and back navigation all collapse because every metric is a set of session ids.
 * Step ids that appear in events but not in `stepOrder` are appended (type null) so the
 * dashboard never silently loses a step that an older config introduced.
 */
export function aggregate(events: AggregateEvent[], stepOrder: StepOrderEntry[]): AggregateResult {
  const overall = newFunnel();
  const byVariant = new Map<string, Funnel>();
  const byVersion = new Map<string, Funnel>();

  const reached = new Map<string, Set<string>>();
  const completed = new Map<string, Set<string>>();
  const lastView = new Map<string, LastView>();
  const seenSteps = new Set<string>();

  for (const event of events) {
    const session = event.session_id;
    track(overall, event.name, session);
    track(group(byVariant, event.variant), event.name, session);
    track(group(byVersion, String(event.funnel_version)), event.name, session);

    const stepId = event.step_id;
    if (stepId === null || stepId === '') continue;

    if (event.name === 'step_viewed') {
      seenSteps.add(stepId);
      add(reached, stepId, session);
      const view: LastView = { stepId, client: parseTime(event.client_timestamp), server: parseTime(event.server_timestamp) };
      const previous = lastView.get(session);
      if (!previous || isLater(view, previous)) lastView.set(session, view);
    } else if (event.name === 'step_completed') {
      seenSteps.add(stepId);
      add(completed, stepId, session);
    }
  }

  const order: StepOrderEntry[] = [...stepOrder];
  const known = new Set(stepOrder.map((s) => s.stepId));
  for (const stepId of [...seenSteps].filter((id) => !known.has(id)).sort()) {
    order.push({ stepId, type: null });
  }

  // Exits: where a session that started, but never saw a result, stopped looking.
  const exits = new Map<string, number>();
  let exitsBeforeFirstStep = 0;
  for (const session of overall.started) {
    if (overall.reachedResult.has(session)) continue;
    const last = lastView.get(session);
    if (!last) {
      exitsBeforeFirstStep++;
      continue;
    }
    exits.set(last.stepId, (exits.get(last.stepId) ?? 0) + 1);
  }

  const started = overall.started.size;
  const steps: StepRow[] = order.map((entry) => {
    const reachedCount = reached.get(entry.stepId)?.size ?? 0;
    const completedCount = completed.get(entry.stepId)?.size ?? 0;
    const exitCount = exits.get(entry.stepId) ?? 0;
    return {
      stepId: entry.stepId,
      type: entry.type,
      reached: reachedCount,
      reachRate: rate(reachedCount, started),
      completed: completedCount,
      completionRate: rate(completedCount, reachedCount),
      exits: exitCount,
      exitRate: rate(exitCount, reachedCount),
    };
  });

  return {
    totals: toTotals(overall),
    steps,
    exitsBeforeFirstStep,
    byVariant: Object.fromEntries([...byVariant].map(([key, funnel]) => [key, toTotals(funnel)])),
    byVersion: Object.fromEntries([...byVersion].map(([key, funnel]) => [key, toTotals(funnel)])),
  };
}

function newFunnel(): Funnel {
  return { started: new Set(), reachedResult: new Set(), ctaClicked: new Set() };
}

function group(map: Map<string, Funnel>, key: string): Funnel {
  const existing = map.get(key);
  if (existing) return existing;
  const created = newFunnel();
  map.set(key, created);
  return created;
}

function track(funnel: Funnel, name: string, session: string): void {
  if (name === 'session_started') funnel.started.add(session);
  else if (name === 'result_viewed') funnel.reachedResult.add(session);
  else if (name === 'cta_clicked') funnel.ctaClicked.add(session);
}

function add(map: Map<string, Set<string>>, key: string, session: string): void {
  const set = map.get(key);
  if (set) set.add(session);
  else map.set(key, new Set([session]));
}

function toTotals(funnel: Funnel): Totals {
  return {
    started: funnel.started.size,
    reachedResult: funnel.reachedResult.size,
    ctaClicked: funnel.ctaClicked.size,
    ctr: rate(funnel.ctaClicked.size, funnel.reachedResult.size),
    primary: rate(funnel.ctaClicked.size, funnel.started.size),
  };
}

/** Rates are null rather than 0 when nobody is in the denominator: "no data" is not "0 %". */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Ordering is (client_timestamp, server_timestamp). On an exact tie of both, the view that
 * arrives later in `events` wins — the analytics query returns rows in insertion order.
 */
function isLater(a: LastView, b: LastView): boolean {
  return a.client !== b.client ? a.client > b.client : a.server >= b.server;
}

function parseTime(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}
