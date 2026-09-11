import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import type { CreateSessionRequest, SessionResponse } from '../../shared/api';
import { loadRawConfig } from '../helpers/configs';

describe('A/B assignment', () => {
  const app = buildApp();

  const create = async (payload: CreateSessionRequest = {}): Promise<SessionResponse> => {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload });
    expect(res.statusCode).toBe(201);
    return res.json() as SessionResponse;
  };

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('splits server-assigned sessions roughly by weight', async () => {
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 400; i++) {
      const { session } = await create();
      expect(session.assignmentSource).toBe('server');
      counts[session.variant] = (counts[session.variant] ?? 0) + 1;
    }
    expect(counts.A! + counts.B!).toBe(400);
    const shareOfA = counts.A! / 400;
    expect(shareOfA).toBeGreaterThanOrEqual(0.4);
    expect(shareOfA).toBeLessThanOrEqual(0.6);
  });

  it('honours an explicit variantOverride', async () => {
    const { session, config } = await create({ variantOverride: 'B' });
    expect(session.variant).toBe('B');
    expect(session.assignmentSource).toBe('override');
    // Variant B reorders the sequence: work_mode comes right after intro.
    expect(config.experiment.variants.B!.stepSequence[1]).toBe('work_mode');
  });

  it('honours the override query param from the landing page', async () => {
    const { session } = await create({ query: { variant: 'B', utm_source: 'ads' } });
    expect(session.variant).toBe('B');
    expect(session.assignmentSource).toBe('override');
  });

  it('prefers variantOverride over the query param', async () => {
    const { session } = await create({ variantOverride: 'A', query: { variant: 'B' } });
    expect(session.variant).toBe('A');
    expect(session.assignmentSource).toBe('override');
  });

  it('falls back to server assignment for an unknown override', async () => {
    const { session } = await create({ variantOverride: 'Z' });
    expect(['A', 'B']).toContain(session.variant);
    expect(session.assignmentSource).toBe('server');
  });

  it('keeps the variant stable across reads', async () => {
    const { session } = await create();
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}` });
      const body = res.json() as SessionResponse;
      expect(body.session.variant).toBe(session.variant);
      expect(body.session.assignmentSource).toBe(session.assignmentSource);
      expect(body.session.version).toBe(session.version);
    }
  });

  it('stamps version, variant, experiment and UTM from the session onto session_started', async () => {
    const { session } = await create({ variantOverride: 'B', utm: { source: 'newsletter', medium: 'email', campaign: 'spring' } });
    const rows = app.ctx.db.prepare('SELECT * FROM events WHERE session_id = ?').all(session.id) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'session_started',
      funnel_id: 'workstyle-planner',
      funnel_version: 1,
      variant: 'B',
      assignment_source: 'override',
      experiment_id: 'question-order-and-result-framing-v1',
      step_id: null,
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
      properties_json: '{}',
    });
    expect(String(rows[0]!.event_id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses the client timestamp for session_started when one is sent', async () => {
    const clientTimestamp = '2026-09-10T08:00:00.000Z';
    const { session } = await create({ clientTimestamp });
    const row = app.ctx.db.prepare('SELECT client_timestamp, server_timestamp FROM events WHERE session_id = ?').get(session.id) as {
      client_timestamp: string;
      server_timestamp: string;
    };
    expect(row.client_timestamp).toBe(clientTimestamp);
    expect(row.server_timestamp).not.toBe(clientTimestamp);
  });
});
