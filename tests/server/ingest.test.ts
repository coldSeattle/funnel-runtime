import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import type { IncomingEvent, IngestResponse, SessionResponse } from '../../shared/api';
import { loadRawConfig } from '../helpers/configs';

describe('event ingestion', () => {
  const app = buildApp();
  let v1 = '';
  let v3 = '';

  const ingest = async (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/events', payload: payload as Record<string, unknown> });

  const event = (over: Partial<IncomingEvent> & { event_id: string; session_id: string }): IncomingEvent => ({
    name: 'step_viewed',
    client_timestamp: '2026-09-11T10:00:00.000Z',
    step_id: 'intro',
    ...over,
  });

  beforeAll(async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
    v1 = ((await app.inject({ method: 'POST', url: '/api/sessions', payload: { variantOverride: 'A' } })).json() as SessionResponse)
      .session.id;
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });
    v3 = ((await app.inject({ method: 'POST', url: '/api/sessions', payload: { variantOverride: 'B' } })).json() as SessionResponse)
      .session.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('accepts a batch and reports the same batch as duplicates on retry', async () => {
    const batch = {
      events: [
        event({ event_id: 'e1', session_id: v1 }),
        event({ event_id: 'e2', session_id: v1, name: 'answer_submitted', step_id: 'team_size', properties: { answer_kind: 'number' } }),
        event({ event_id: 'e3', session_id: v1, name: 'step_completed', step_id: 'team_size', properties: { next_step_id: 'work_mode' } }),
      ],
    };

    const first = (await ingest(batch)).json() as IngestResponse;
    expect(first).toMatchObject({ accepted: 3, duplicates: 0, rejected: 0 });
    expect(first.results.map((r) => [r.event_id, r.status])).toEqual([
      ['e1', 'accepted'],
      ['e2', 'accepted'],
      ['e3', 'accepted'],
    ]);

    const retry = await ingest(batch);
    expect(retry.statusCode).toBe(200);
    const second = retry.json() as IngestResponse;
    expect(second).toMatchObject({ accepted: 0, duplicates: 3, rejected: 0 });
    expect(second.results.every((r) => r.status === 'duplicate')).toBe(true);
  });

  it('collapses duplicates inside one batch', async () => {
    const res = (
      await ingest({
        events: [event({ event_id: 'dup', session_id: v1 }), event({ event_id: 'dup', session_id: v1 })],
      })
    ).json() as IngestResponse;
    expect(res).toMatchObject({ accepted: 1, duplicates: 1, rejected: 0 });
  });

  it('rejects a malformed event without dropping the rest of the batch', async () => {
    const res = (
      await ingest({
        events: [
          event({ event_id: 'ok1', session_id: v1, name: 'back_clicked', step_id: 'work_mode' }),
          { event_id: 'broken', session_id: v1, client_timestamp: '2026-09-11T10:00:00.000Z' },
          event({ event_id: 'ok2', session_id: v1, name: 'result_viewed', step_id: 'result' }),
          { session_id: v1, name: 'step_viewed', client_timestamp: 'not-a-date' },
        ],
      })
    ).json() as IngestResponse;

    expect(res).toMatchObject({ accepted: 2, duplicates: 0, rejected: 2 });
    expect(res.results.map((r) => [r.event_id, r.status, r.reason])).toEqual([
      ['ok1', 'accepted', undefined],
      ['broken', 'rejected', 'invalid_shape'],
      ['ok2', 'accepted', undefined],
      [null, 'rejected', 'invalid_shape'],
    ]);
  });

  it('rejects events for an unknown session', async () => {
    const res = (await ingest({ events: [event({ event_id: 'ghost', session_id: 'no-such-session' })] })).json() as IngestResponse;
    expect(res).toMatchObject({ accepted: 0, duplicates: 0, rejected: 1 });
    expect(res.results[0]).toMatchObject({ event_id: 'ghost', status: 'rejected', reason: 'unknown_session' });
  });

  it('allows an event only when the session version allows it', async () => {
    const onV1 = (
      await ingest({ events: [event({ event_id: 'rec1', session_id: v1, name: 'recommendation_expanded', step_id: 'result' })] })
    ).json() as IngestResponse;
    expect(onV1.results[0]).toMatchObject({ status: 'rejected', reason: 'unknown_event' });

    const onV3 = (
      await ingest({ events: [event({ event_id: 'rec2', session_id: v3, name: 'recommendation_expanded', step_id: 'result' })] })
    ).json() as IngestResponse;
    expect(onV3.results[0]).toMatchObject({ status: 'accepted' });
  });

  it('keeps whitelisted properties and drops everything else', async () => {
    await ingest({
      events: [
        event({
          event_id: 'props',
          session_id: v1,
          name: 'answer_submitted',
          step_id: 'work_mode',
          properties: { answer_kind: 'single', answer: 'hybrid', team_size: 12 },
        }),
      ],
    });
    const row = app.ctx.db.prepare('SELECT properties_json FROM events WHERE event_id = ?').get('props') as { properties_json: string };
    expect(JSON.parse(row.properties_json)).toEqual({ answer_kind: 'single' });
  });

  it('takes version, variant and UTM from the session and ignores client-supplied columns', async () => {
    await ingest({
      events: [
        {
          ...event({ event_id: 'stamped', session_id: v3, name: 'cta_clicked', step_id: 'result' }),
          funnel_version: 99,
          variant: 'Z',
          utm_campaign: 'injected',
          server_timestamp: '1999-01-01T00:00:00.000Z',
        } as IncomingEvent,
      ],
    });
    const row = app.ctx.db.prepare('SELECT * FROM events WHERE event_id = ?').get('stamped') as Record<string, unknown>;
    expect(row).toMatchObject({
      funnel_version: 3,
      variant: 'B',
      assignment_source: 'override',
      experiment_id: 'question-order-and-result-framing-v3',
      funnel_id: 'workstyle-planner',
      utm_campaign: null,
    });
    expect(Date.parse(String(row.server_timestamp))).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('400s on a body without an events array', async () => {
    for (const payload of [{}, { events: 'nope' }, []]) {
      const res = await ingest(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_body');
    }
  });

  it('400s invalid_body on a syntactically broken JSON body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { 'content-type': 'application/json' },
      payload: '{"events": [',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('400s on a batch larger than 500 events', async () => {
    const events = Array.from({ length: 501 }, (_, i) => event({ event_id: `big${i}`, session_id: v1 }));
    const res = await ingest({ events });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('batch_too_large');
    expect(app.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE event_id LIKE 'big%'").get()).toEqual({ n: 0 });
  });

  it('accepts a batch of exactly 500 events', async () => {
    const events = Array.from({ length: 500 }, (_, i) => event({ event_id: `max${i}`, session_id: v1 }));
    const res = (await ingest({ events })).json() as IngestResponse;
    expect(res.accepted).toBe(500);
  });
});
