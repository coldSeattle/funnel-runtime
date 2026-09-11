import { describe, expect, it } from 'vitest';
import { aggregate, type AggregateEvent, type StepOrderEntry } from '../../server/services/aggregate';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 10, 0, seconds)).toISOString();

interface Spec {
  session: string;
  name: string;
  step?: string;
  /** client_timestamp, in seconds from the fixture epoch */
  c: number;
  /** server_timestamp, defaults to the client timestamp */
  s?: number;
  variant: string;
  version?: number;
}

const row = (spec: Spec): AggregateEvent => ({
  session_id: spec.session,
  name: spec.name,
  step_id: spec.step ?? null,
  client_timestamp: at(spec.c),
  server_timestamp: at(spec.s ?? spec.c),
  variant: spec.variant,
  funnel_version: spec.version ?? 1,
});

/**
 * Six sessions, written out by hand so every expected number below can be checked by eye.
 * s1 completes and clicks the CTA, s2 drops on work_mode (with a duplicate view), s3 reaches
 * the result without a CTA (its events are appended in reverse order), s4 goes back to intro
 * and leaves there, s5 never sees a step, s6 runs on version 3 and views an unknown step.
 */
function fixture(): AggregateEvent[] {
  const events: AggregateEvent[] = [];

  // s1 — variant A, full pass with CTA
  events.push(
    row({ session: 's1', name: 'session_started', c: 0, variant: 'A' }),
    row({ session: 's1', name: 'step_viewed', step: 'intro', c: 1, variant: 'A' }),
    row({ session: 's1', name: 'step_completed', step: 'intro', c: 2, variant: 'A' }),
    row({ session: 's1', name: 'step_viewed', step: 'work_mode', c: 3, variant: 'A' }),
    row({ session: 's1', name: 'answer_submitted', step: 'work_mode', c: 4, variant: 'A' }),
    row({ session: 's1', name: 'step_completed', step: 'work_mode', c: 5, variant: 'A' }),
    row({ session: 's1', name: 'step_viewed', step: 'result', c: 6, variant: 'A' }),
    row({ session: 's1', name: 'result_viewed', step: 'result', c: 7, variant: 'A' }),
    row({ session: 's1', name: 'cta_clicked', step: 'result', c: 8, variant: 'A' }),
  );

  // s2 — variant A, leaves on work_mode; the repeated view must not double-count
  events.push(
    row({ session: 's2', name: 'session_started', c: 0, variant: 'A' }),
    row({ session: 's2', name: 'step_viewed', step: 'intro', c: 1, variant: 'A' }),
    row({ session: 's2', name: 'step_completed', step: 'intro', c: 2, variant: 'A' }),
    row({ session: 's2', name: 'step_viewed', step: 'work_mode', c: 3, variant: 'A' }),
    row({ session: 's2', name: 'step_viewed', step: 'work_mode', c: 4, variant: 'A' }),
  );

  // s3 — variant B, reaches the result without a CTA; events arrive in reverse order
  const s3 = [
    row({ session: 's3', name: 'session_started', c: 0, variant: 'B' }),
    row({ session: 's3', name: 'step_viewed', step: 'intro', c: 1, variant: 'B' }),
    row({ session: 's3', name: 'step_completed', step: 'intro', c: 2, variant: 'B' }),
    row({ session: 's3', name: 'step_viewed', step: 'work_mode', c: 3, variant: 'B' }),
    row({ session: 's3', name: 'step_completed', step: 'work_mode', c: 4, variant: 'B' }),
    row({ session: 's3', name: 'step_viewed', step: 'result', c: 5, variant: 'B' }),
    row({ session: 's3', name: 'result_viewed', step: 'result', c: 6, variant: 'B' }),
  ];
  events.push(...s3.reverse());

  // s4 — variant B, goes back to intro and leaves there. The second intro view shares the
  // client timestamp of the work_mode view, so only the server timestamp breaks the tie.
  events.push(
    row({ session: 's4', name: 'session_started', c: 0, variant: 'B' }),
    row({ session: 's4', name: 'step_viewed', step: 'intro', c: 1, variant: 'B' }),
    row({ session: 's4', name: 'step_completed', step: 'intro', c: 2, variant: 'B' }),
    row({ session: 's4', name: 'step_viewed', step: 'work_mode', c: 3, variant: 'B' }),
    row({ session: 's4', name: 'back_clicked', step: 'work_mode', c: 3, s: 8, variant: 'B' }),
    row({ session: 's4', name: 'step_viewed', step: 'intro', c: 3, s: 9, variant: 'B' }),
  );

  // s5 — variant A, opened the funnel and never saw a step
  events.push(row({ session: 's5', name: 'session_started', c: 0, variant: 'A' }));

  // s6 — variant B on version 3, full pass with CTA plus a step that no config knows about
  events.push(
    row({ session: 's6', name: 'session_started', c: 0, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'step_viewed', step: 'intro', c: 1, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'step_viewed', step: 'work_mode', c: 2, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'step_viewed', step: 'legacy_step', c: 3, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'step_viewed', step: 'result', c: 4, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'result_viewed', step: 'result', c: 5, variant: 'B', version: 3 }),
    row({ session: 's6', name: 'cta_clicked', step: 'result', c: 6, variant: 'B', version: 3 }),
  );

  return events;
}

const stepOrder: StepOrderEntry[] = [
  { stepId: 'intro', type: 'info' },
  { stepId: 'work_mode', type: 'single-select' },
  { stepId: 'timezone_span', type: 'single-select' },
  { stepId: 'result', type: 'result' },
];

describe('aggregate', () => {
  const result = aggregate(fixture(), stepOrder);
  const step = (id: string) => result.steps.find((s) => s.stepId === id)!;

  it('counts unique sessions, not events', () => {
    expect(result.totals).toEqual({
      started: 6,
      reachedResult: 3,
      ctaClicked: 2,
      ctr: 2 / 3,
      primary: 2 / 6,
    });
  });

  it('reports reach and completion per step', () => {
    expect(step('intro')).toEqual({
      stepId: 'intro',
      type: 'info',
      reached: 5,
      reachRate: 5 / 6,
      completed: 4,
      completionRate: 4 / 5,
      exits: 1,
      exitRate: 1 / 5,
    });
    expect(step('work_mode')).toMatchObject({ reached: 5, completed: 2, completionRate: 2 / 5 });
    expect(step('result')).toMatchObject({ reached: 3, reachRate: 0.5, completed: 0, exits: 0 });
  });

  it('keeps steps nobody reached, with null rates instead of divisions by zero', () => {
    expect(step('timezone_span')).toEqual({
      stepId: 'timezone_span',
      type: 'single-select',
      reached: 0,
      reachRate: 0,
      completed: 0,
      completionRate: null,
      exits: 0,
      exitRate: null,
    });
  });

  it('appends step ids seen in events but missing from the configs', () => {
    expect(result.steps.map((s) => s.stepId)).toEqual(['intro', 'work_mode', 'timezone_span', 'result', 'legacy_step']);
    expect(step('legacy_step')).toMatchObject({ type: null, reached: 1 });
  });

  it('attributes an exit to the last viewed step, breaking ties on the server timestamp', () => {
    expect(step('work_mode').exits).toBe(1); // s2
    expect(step('intro').exits).toBe(1); // s4 went back to intro and stopped there
    expect(result.exitsBeforeFirstStep).toBe(1); // s5 never saw a step
  });

  it('satisfies the dashboard invariant: exits + exitsBeforeFirstStep + reachedResult = started', () => {
    const exits = result.steps.reduce((sum, s) => sum + s.exits, 0);
    expect(exits + result.exitsBeforeFirstStep + result.totals.reachedResult).toBe(result.totals.started);
  });

  it('groups the same totals by variant', () => {
    expect(result.byVariant).toEqual({
      A: { started: 3, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 1 / 3 },
      B: { started: 3, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 1 / 3 },
    });
  });

  it('groups the same totals by version', () => {
    expect(result.byVersion).toEqual({
      '1': { started: 5, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 0.2 },
      '3': { started: 1, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 1 },
    });
  });

  it('does not care about the order events arrive in', () => {
    const shuffled = [...fixture()].reverse();
    expect(aggregate(shuffled, stepOrder)).toEqual(result);
  });

  it('ignores sessions without session_started, so the invariant holds for orphan events', () => {
    // s7 has no session_started (e.g. the filter cut it, or its start event was lost): none of
    // its events may count anywhere, overall or per variant / version.
    const orphan = [
      row({ session: 's7', name: 'step_viewed', step: 'intro', c: 1, variant: 'A' }),
      row({ session: 's7', name: 'step_completed', step: 'intro', c: 2, variant: 'A' }),
      row({ session: 's7', name: 'step_viewed', step: 'result', c: 3, variant: 'A' }),
      row({ session: 's7', name: 'result_viewed', step: 'result', c: 4, variant: 'A' }),
      row({ session: 's7', name: 'cta_clicked', step: 'result', c: 5, variant: 'A' }),
      row({ session: 's8', name: 'result_viewed', step: 'result', c: 1, variant: 'C', version: 2 }),
    ];
    const withOrphans = aggregate([...fixture(), ...orphan], stepOrder);
    expect(withOrphans).toEqual(result);

    const onlyOrphans = aggregate(orphan, stepOrder);
    expect(onlyOrphans.totals).toEqual({ started: 0, reachedResult: 0, ctaClicked: 0, ctr: null, primary: null });
    expect(onlyOrphans.steps.every((s) => s.reached === 0 && s.completed === 0 && s.exits === 0)).toBe(true);
    expect(onlyOrphans.byVariant).toEqual({});
    expect(onlyOrphans.byVersion).toEqual({});
    const exits = onlyOrphans.steps.reduce((sum, s) => sum + s.exits, 0);
    expect(exits + onlyOrphans.exitsBeforeFirstStep + onlyOrphans.totals.reachedResult).toBe(onlyOrphans.totals.started);
  });

  it('returns zeroed totals and null rates for an empty event set', () => {
    const empty = aggregate([], stepOrder);
    expect(empty.totals).toEqual({ started: 0, reachedResult: 0, ctaClicked: 0, ctr: null, primary: null });
    expect(empty.exitsBeforeFirstStep).toBe(0);
    expect(empty.steps.map((s) => s.reachRate)).toEqual([null, null, null, null]);
    expect(empty.byVariant).toEqual({});
    expect(empty.byVersion).toEqual({});
  });
});
