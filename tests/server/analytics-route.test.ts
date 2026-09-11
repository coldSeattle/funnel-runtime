import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import type { AnalyticsResponse, CreateSessionRequest, IncomingEvent, SessionResponse } from '../../shared/api';
import { loadRawConfig } from '../helpers/configs';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 11, 10, 0, seconds)).toISOString();

/**
 * The aggregate fixture replayed through the real API: sessions via POST /api/sessions,
 * events via POST /api/events. s1–s4 run on v1 with server assignment, s5 on v1 and s6 on v3
 * as override sessions, so excludeOverrides cuts a subset that no version filter produces.
 */
describe('GET /api/analytics', () => {
  const app = buildApp();

  const createSession = async (payload: CreateSessionRequest): Promise<string> => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { clientTimestamp: at(0), ...payload } });
    expect(res.statusCode).toBe(201);
    return (res.json() as SessionResponse).session.id;
  };

  // Variants are forced with an override to keep the fixture deterministic, then relabelled as
  // server-assigned so that excludeOverrides removes exactly the real override sessions, s5 and s6.
  const markServerAssigned = (id: string) => {
    app.ctx.db.prepare("UPDATE sessions SET assignment_source = 'server' WHERE id = ?").run(id);
    app.ctx.db.prepare("UPDATE events SET assignment_source = 'server' WHERE session_id = ?").run(id);
  };

  const ev = (session: string, name: string, step: string, c: number): IncomingEvent => ({
    event_id: randomUUID(),
    session_id: session,
    name,
    step_id: step,
    client_timestamp: at(c),
  });

  const send = async (events: IncomingEvent[]) => {
    const res = await app.inject({ method: 'POST', url: '/api/events', payload: { events } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected).toBe(0);
  };

  const get = async (query = ''): Promise<AnalyticsResponse> => {
    const res = await app.inject({ method: 'GET', url: `/api/analytics${query}` });
    expect(res.statusCode).toBe(200);
    return res.json() as AnalyticsResponse;
  };

  const invariantHolds = (body: AnalyticsResponse) =>
    body.steps.reduce((sum, s) => sum + s.exits, 0) + body.exitsBeforeFirstStep + body.totals.reachedResult ===
    body.totals.started;

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });

    const s1 = await createSession({ variantOverride: 'A', utm: { campaign: 'spring' } });
    const s2 = await createSession({ variantOverride: 'A', utm: { campaign: 'spring' } });
    const s3 = await createSession({ variantOverride: 'B', utm: { campaign: 'autumn' } });
    const s4 = await createSession({ variantOverride: 'B' });
    const s5 = await createSession({ variantOverride: 'A', utm: { campaign: 'winter' } });
    [s1, s2, s3, s4].forEach(markServerAssigned);

    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });
    const s6 = await createSession({ variantOverride: 'B', utm: { campaign: 'autumn' } });

    await send([
      ev(s1, 'step_viewed', 'intro', 1),
      ev(s1, 'step_completed', 'intro', 2),
      ev(s1, 'step_viewed', 'work_mode', 3),
      ev(s1, 'answer_submitted', 'work_mode', 4),
      ev(s1, 'step_completed', 'work_mode', 5),
      ev(s1, 'step_viewed', 'result', 6),
      ev(s1, 'result_viewed', 'result', 7),
      ev(s1, 'cta_clicked', 'result', 8),
    ]);
    const s2Batch = [
      ev(s2, 'step_viewed', 'intro', 1),
      ev(s2, 'step_completed', 'intro', 2),
      ev(s2, 'step_viewed', 'work_mode', 3),
      ev(s2, 'step_viewed', 'work_mode', 4),
    ];
    await send(s2Batch);
    await send(s2Batch); // a retried flush: every event is a duplicate and changes nothing
    await send(
      [
        ev(s3, 'step_viewed', 'intro', 1),
        ev(s3, 'step_completed', 'intro', 2),
        ev(s3, 'step_viewed', 'work_mode', 3),
        ev(s3, 'step_completed', 'work_mode', 4),
        ev(s3, 'step_viewed', 'result', 5),
        ev(s3, 'result_viewed', 'result', 6),
      ].reverse(),
    );
    await send([
      ev(s4, 'step_viewed', 'intro', 1),
      ev(s4, 'step_completed', 'intro', 2),
      ev(s4, 'step_viewed', 'work_mode', 3),
      ev(s4, 'back_clicked', 'work_mode', 4),
      ev(s4, 'step_viewed', 'intro', 5),
    ]);
    await send([
      ev(s6, 'step_viewed', 'intro', 1),
      ev(s6, 'step_viewed', 'work_mode', 2),
      ev(s6, 'step_viewed', 'legacy_step', 3),
      ev(s6, 'step_viewed', 'result', 4),
      ev(s6, 'result_viewed', 'result', 5),
      ev(s6, 'cta_clicked', 'result', 6),
    ]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('aggregates everything when no filter is set', async () => {
    const body = await get();
    expect(body.filters).toEqual({});
    expect(body.totals).toEqual({ started: 6, reachedResult: 3, ctaClicked: 2, ctr: 2 / 3, primary: 2 / 6 });
    expect(body.exitsBeforeFirstStep).toBe(1);
    const step = (id: string) => body.steps.find((s) => s.stepId === id)!;
    expect(step('intro')).toMatchObject({ type: 'info', reached: 5, completed: 4, exits: 1 });
    expect(step('work_mode')).toMatchObject({ type: 'single-select', reached: 5, completed: 2, exits: 1 });
    expect(step('result')).toMatchObject({ type: 'result', reached: 3, exits: 0 });
    expect(step('team_size')).toMatchObject({ type: 'number', reached: 0, reachRate: 0, completionRate: null });
    expect(invariantHolds(body)).toBe(true);
    expect(body.byVariant).toEqual({
      A: { started: 3, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 1 / 3 },
      B: { started: 3, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 1 / 3 },
    });
    expect(body.byVersion).toEqual({
      '1': { started: 5, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 0.2 },
      '3': { started: 1, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 1 },
    });
  });

  it('orders steps across all versions: v1 sequence, then steps new in v3, then unknown ones, result last', async () => {
    const body = await get();
    expect(body.steps.map((s) => s.stepId)).toEqual([
      'intro',
      'team_size',
      'work_mode',
      'priorities',
      'timezone_span',
      'office_days',
      'async_maturity',
      'tool_count',
      'security_constraints',
      'meeting_hours',
      'legacy_step',
      'result',
    ]);
    // v1 puts `result` before the steps v3 added; the dashboard still ends on the result row.
    expect(body.steps.at(-1)).toMatchObject({ stepId: 'result', type: 'result', reached: 3 });
    expect(body.steps.find((s) => s.stepId === 'legacy_step')).toMatchObject({ type: null, reached: 1 });
  });

  it('lists the filter options from stored versions and sessions', async () => {
    const body = await get();
    expect(body.options).toEqual({ versions: [1, 3], variants: ['A', 'B'], campaigns: ['autumn', 'spring', 'winter'] });
  });

  it('filters by variant', async () => {
    const body = await get('?variant=B');
    expect(body.filters).toEqual({ variant: 'B' });
    expect(body.totals).toEqual({ started: 3, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 1 / 3 });
    expect(Object.keys(body.byVariant)).toEqual(['B']);
    expect(invariantHolds(body)).toBe(true);
  });

  it('excludes override sessions on request', async () => {
    for (const flag of ['1', 'true']) {
      const body = await get(`?excludeOverrides=${flag}`);
      expect(body.filters).toEqual({ excludeOverrides: true });
      expect(body.totals).toEqual({ started: 4, reachedResult: 2, ctaClicked: 1, ctr: 0.5, primary: 0.25 });
      expect(body.exitsBeforeFirstStep).toBe(0); // s5, the only session without a view, is an override
      expect(body.byVariant).toEqual({
        A: { started: 2, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 0.5 },
        B: { started: 2, reachedResult: 1, ctaClicked: 0, ctr: 0, primary: 0 },
      });
      expect(Object.keys(body.byVersion)).toEqual(['1']);
      expect(invariantHolds(body)).toBe(true);
    }
    // Overrides live on both versions, so no version filter selects the same sessions.
    const v1 = await get('?version=1');
    expect(v1.totals.started).toBe(5);
    expect(v1.exitsBeforeFirstStep).toBe(1);
  });

  it('filters by version and orders steps by that version only', async () => {
    const body = await get('?version=3');
    expect(body.filters).toEqual({ version: 3 });
    expect(body.totals).toEqual({ started: 1, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 1 });
    expect(invariantHolds(body)).toBe(true);
    expect(body.steps.map((s) => s.stepId)).toEqual([
      'intro',
      'team_size',
      'work_mode',
      'priorities',
      'security_constraints',
      'timezone_span',
      'office_days',
      'meeting_hours',
      'async_maturity',
      'tool_count',
      'legacy_step',
      'result',
    ]);
  });

  it('filters by utm_campaign', async () => {
    const body = await get('?utm_campaign=spring');
    expect(body.filters).toEqual({ utmCampaign: 'spring' });
    expect(body.totals).toEqual({ started: 2, reachedResult: 1, ctaClicked: 1, ctr: 1, primary: 0.5 });
    expect(body.steps.find((s) => s.stepId === 'work_mode')!.exits).toBe(1);
    expect(invariantHolds(body)).toBe(true);
  });

  it('combines filters', async () => {
    const body = await get('?version=1&variant=B&excludeOverrides=1');
    expect(body.totals).toEqual({ started: 2, reachedResult: 1, ctaClicked: 0, ctr: 0, primary: 0 });
    expect(invariantHolds(body)).toBe(true);
  });

  it('treats empty params as "no filter" and rejects a non-numeric version', async () => {
    const empty = await get('?version=&variant=&utm_campaign=&excludeOverrides=0');
    expect(empty.filters).toEqual({});
    expect(empty.totals.started).toBe(6);

    const res = await app.inject({ method: 'GET', url: '/api/analytics?version=abc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_filter');
  });

  it.each(['0x1', '1e0', '-1', '1.5', '+1', '1.0', '99999999999999999999'])(
    'rejects version=%s: only plain decimal digits are a version number',
    async (version) => {
      const res = await app.inject({ method: 'GET', url: `/api/analytics?version=${encodeURIComponent(version)}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_filter');
    },
  );
});

describe('GET /api/analytics on an empty database', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('returns zeroed totals, null rates and empty options', async () => {
    for (const query of ['', '?version=1&variant=A&excludeOverrides=1']) {
      const res = await app.inject({ method: 'GET', url: `/api/analytics${query}` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AnalyticsResponse;
      expect(body.totals).toEqual({ started: 0, reachedResult: 0, ctaClicked: 0, ctr: null, primary: null });
      expect(body.steps).toEqual([]);
      expect(body.exitsBeforeFirstStep).toBe(0);
      expect(body.byVariant).toEqual({});
      expect(body.byVersion).toEqual({});
      expect(body.options).toEqual({ versions: [], variants: [], campaigns: [] });
    }
  });
});
