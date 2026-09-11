import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import type { SessionResponse, UpdateStateResponse } from '../../shared/api';
import { loadRawConfig } from '../helpers/configs';

describe('sessions without an active version', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('503s when nothing is published yet', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('no_active_version');
  });
});

describe('session create body validation', () => {
  const app = buildApp();
  const sessionCount = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
  });
  afterAll(async () => {
    await app.close();
  });

  it.each([
    ['a non-string variantOverride', { variantOverride: ['B'] }],
    ['a non-string query value', { query: { variant: ['B'] } }],
    ['an object UTM field', { utm: { source: {} } }],
    ['a numeric UTM field', { utm: { campaign: 42 } }],
    ['a non-object utm', { utm: 'spring' }],
    ['a non-string clientTimestamp', { clientTimestamp: 1757577600000 }],
    ['an array body', [{ variantOverride: 'B' }]],
  ])('400s invalid_body on %s without creating a session', async (_label, payload) => {
    const before = sessionCount();
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: payload as object });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('invalid_body');
    expect(err.message).not.toMatch(/sqlite/i);
    expect(Array.isArray(err.details)).toBe(true);
    expect(err.details.length).toBeGreaterThan(0);
    expect(sessionCount()).toBe(before);
  });

  it('keeps string UTM values identical across create, read and analytics options', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { utm: { source: null, campaign: '42' }, query: { utm_medium: 'cpc' } },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as SessionResponse;
    expect(created.session.utm).toEqual({ source: null, medium: 'cpc', campaign: '42' });

    const reread = (await app.inject({ method: 'GET', url: `/api/sessions/${created.session.id}` })).json() as SessionResponse;
    expect(reread.session.utm).toEqual(created.session.utm);

    // A numeric campaign used to be stored as REAL and read back as "42.0" next to the string "42".
    const campaigns = (await app.inject({ method: 'GET', url: '/api/analytics' })).json().options.campaigns as string[];
    expect(campaigns).toContain('42');
    expect(campaigns).not.toContain('42.0');
  });

  const sessionStarted = (id: string) =>
    app.ctx.db
      .prepare("SELECT client_timestamp, server_timestamp FROM events WHERE session_id = ? AND name = 'session_started'")
      .get(id) as { client_timestamp: string; server_timestamp: string };

  it.each([
    ['a bare number', '1'],
    ['a locale date', 'Sep 11 2026'],
    ['an ISO datetime without an offset', '2026-09-11T10:00:00'],
    ['garbage', 'not-a-date'],
  ])('starts the session anyway and uses the server time when clientTimestamp is %s', async (_label, clientTimestamp) => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { clientTimestamp } });
    expect(res.statusCode).toBe(201);
    const started = sessionStarted((res.json() as SessionResponse).session.id);
    expect(started.client_timestamp).toBe(started.server_timestamp);
  });

  it('keeps a valid clientTimestamp with an offset, normalised to UTC', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { clientTimestamp: '2026-09-11T13:00:00+03:00' } });
    expect(res.statusCode).toBe(201);
    expect(sessionStarted((res.json() as SessionResponse).session.id).client_timestamp).toBe('2026-09-11T10:00:00.000Z');
  });

  it('still accepts a bodiless create sent with a JSON content-type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as SessionResponse).session.assignmentSource).toBe('server');
  });
});

describe('sessions', () => {
  const app = buildApp();
  let v1SessionId = '';
  let v3SessionId = '';

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates a session on the active version', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { utm: { source: 'newsletter', medium: 'email', campaign: 'spring' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as SessionResponse;
    v1SessionId = body.session.id;

    expect(body.session).toMatchObject({
      funnelId: 'workstyle-planner',
      version: 1,
      experimentId: 'question-order-and-result-framing-v1',
      assignmentSource: 'server',
      utm: { source: 'newsletter', medium: 'email', campaign: 'spring' },
      answers: {},
      currentStepId: null,
      resultId: null,
    });
    expect(['A', 'B']).toContain(body.session.variant);
    expect(body.config.version).toBe(1);
    // expires_at = created_at + session.ttlHours (72h in both configs)
    const ttlMs = new Date(body.session.expiresAt).getTime() - new Date(body.session.createdAt).getTime();
    expect(ttlMs).toBe(72 * 3600 * 1000);
  });

  it('reads UTM from the page query when no utm object is sent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { query: { utm_source: 'x', utm_campaign: 'autumn', gclid: 'abc' } },
    });
    const body = res.json() as SessionResponse;
    expect(body.session.utm).toEqual({ source: 'x', medium: null, campaign: 'autumn' });
  });

  it('404s for an unknown session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('session_not_found');
  });

  it('keeps an old session on its own version after a new one is published', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });

    const old = await app.inject({ method: 'GET', url: `/api/sessions/${v1SessionId}` });
    expect(old.statusCode).toBe(200);
    const oldBody = old.json() as SessionResponse;
    expect(oldBody.session.version).toBe(1);
    expect(oldBody.config.version).toBe(1);
    expect(oldBody.config.steps.security_constraints).toBeUndefined();

    const fresh = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const freshBody = fresh.json() as SessionResponse;
    expect(freshBody.session.version).toBe(3);
    expect(freshBody.config.version).toBe(3);
    expect(freshBody.session.experimentId).toBe('question-order-and-result-framing-v3');
    v3SessionId = freshBody.session.id;
  });

  it('keeps a v3 session on v3 after a rollback, while new sessions start on v1 again', async () => {
    const rollback = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json()).toMatchObject({ activeVersion: 1, fromVersion: 3 });

    const pinned = await app.inject({ method: 'GET', url: `/api/sessions/${v3SessionId}` });
    expect(pinned.statusCode).toBe(200);
    const pinnedBody = pinned.json() as SessionResponse;
    expect(pinnedBody.session.version).toBe(3);
    expect(pinnedBody.config.version).toBe(3);

    // security_constraints exists only in v3, so this passes only if state is checked against v3.
    const state = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v3SessionId}/state`,
      payload: { answers: {}, currentStepId: 'security_constraints' },
    });
    expect(state.statusCode).toBe(200);
    expect((state.json() as UpdateStateResponse).session).toMatchObject({ version: 3, currentStepId: 'security_constraints' });

    const fresh = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    expect(fresh.statusCode).toBe(201);
    const freshBody = fresh.json() as SessionResponse;
    expect(freshBody.session.version).toBe(1);
    expect(freshBody.config.version).toBe(1);
  });

  it('stores validated answers and the current step', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: { work_mode: 'hybrid', team_size: '12' }, currentStepId: 'priorities' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as UpdateStateResponse;
    // The validator normalises: the numeric answer is stored as a number, not the raw string.
    expect(body.session.answers).toEqual({ work_mode: 'hybrid', team_size: 12 });
    expect(body.session.currentStepId).toBe('priorities');

    const reread = await app.inject({ method: 'GET', url: `/api/sessions/${v1SessionId}` });
    expect((reread.json() as SessionResponse).session.answers).toEqual({ work_mode: 'hybrid', team_size: 12 });
  });

  it('400s on an answer that fails the step validation', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: { team_size: 900 }, currentStepId: 'team_size' },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('invalid_answer');
    expect(err.details).toMatchObject({ key: 'team_size', message: 'For this demo, enter a value up to 200.' });
  });

  it.each([
    ['a whitespace-only string', '   ', 'Enter the team size.'],
    ['a hex string', '0x10', 'Enter a valid value.'],
    ['an exponent string', '1e1', 'Enter a valid value.'],
  ])('400s on %s for a required number step and stores nothing', async (_label, raw, message) => {
    const before = (await app.inject({ method: 'GET', url: `/api/sessions/${v1SessionId}` })).json() as SessionResponse;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: { work_mode: 'hybrid', team_size: raw }, currentStepId: 'priorities' },
    });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('invalid_answer');
    expect(err.details).toEqual({ key: 'team_size', message });
    const after = (await app.inject({ method: 'GET', url: `/api/sessions/${v1SessionId}` })).json() as SessionResponse;
    expect(after.session.answers).toEqual(before.session.answers);
  });

  it('400s on an answer key that is not in the variant', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: { meeting_hours: 4 }, currentStepId: 'team_size' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_answer');
  });

  it('400s on a step id that is not in the variant', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: {}, currentStepId: 'meeting_hours' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_step');
  });

  it.each([
    ['missing', { answers: {} }],
    ['not a string', { answers: {}, currentStepId: 42 }],
    ['null', { answers: {}, currentStepId: null }],
  ])('400s invalid_body when currentStepId is %s', async (_label, payload) => {
    const res = await app.inject({ method: 'PUT', url: `/api/sessions/${v1SessionId}/state`, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'invalid_body', message: 'currentStepId must be a string' });
  });

  it('400s when answers is not a plain object', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${v1SessionId}/state`,
      payload: { answers: ['hybrid'], currentStepId: 'team_size' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('computes and stores the result for the session variant', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/sessions/${v1SessionId}/result`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.id).toBe('hybrid_structured');

    const reread = await app.inject({ method: 'GET', url: `/api/sessions/${v1SessionId}` });
    expect((reread.json() as SessionResponse).session.resultId).toBe('hybrid_structured');
  });

  it('accepts a bodiless result request sent with a JSON content-type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${v1SessionId}/result`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.id).toBe('hybrid_structured');
  });

  it('410s once the session has expired', async () => {
    const expired = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
    const id = (expired.json() as SessionResponse).session.id;
    app.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', id);

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` });
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('session_expired');

    const state = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${id}/state`,
      payload: { answers: {}, currentStepId: 'intro' },
    });
    expect(state.statusCode).toBe(410);
  });
});

describe('state validation is scoped to the session variant', () => {
  const app = buildApp();
  let variantA = '';
  let variantB = '';

  const put = (id: string, payload: object) => app.inject({ method: 'PUT', url: `/api/sessions/${id}/state`, payload });

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });
    const create = async (variantOverride: string) => {
      const body = (await app.inject({ method: 'POST', url: '/api/sessions', payload: { variantOverride } })).json() as SessionResponse;
      expect(body.session).toMatchObject({ version: 3, variant: variantOverride });
      return body.session.id;
    };
    variantA = await create('A');
    variantB = await create('B');
  });
  afterAll(async () => {
    await app.close();
  });

  // tool_count is a v3 step, but only variant A's sequence contains it.
  it('400s unknown_answer for an answer of a step that only the other variant has', async () => {
    const res = await put(variantB, { answers: { tool_count: 3 }, currentStepId: 'intro' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'unknown_answer', details: { key: 'tool_count' } });
  });

  it('400s unknown_step for a step that only the other variant has', async () => {
    const res = await put(variantB, { answers: {}, currentStepId: 'tool_count' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'unknown_step', details: { currentStepId: 'tool_count' } });
  });

  it('accepts the same payloads on a variant A session', async () => {
    const answer = await put(variantA, { answers: { tool_count: 3 }, currentStepId: 'intro' });
    expect(answer.statusCode).toBe(200);
    expect((answer.json() as UpdateStateResponse).session.answers).toEqual({ tool_count: 3 });

    const step = await put(variantA, { answers: {}, currentStepId: 'tool_count' });
    expect(step.statusCode).toBe(200);
    expect((step.json() as UpdateStateResponse).session.currentStepId).toBe('tool_count');
  });
});
