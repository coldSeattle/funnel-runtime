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

  it.each([
    ['a bare number', '1'],
    ['a locale date', 'Sep 11 2026'],
    ['an ISO datetime without an offset', '2026-09-11T10:00:00'],
    ['a date without a time', '2026-09-11'],
    ['an impossible date', '2026-02-30T10:00:00Z'],
  ])('rejects %s as client_timestamp with invalid_shape', async (_label, clientTimestamp) => {
    const res = (
      await ingest({ events: [event({ event_id: `ts-bad-${clientTimestamp}`, session_id: v1, client_timestamp: clientTimestamp })] })
    ).json() as IngestResponse;
    expect(res.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_shape' });
  });

  it.each([
    ['Z', '2026-09-11T10:00:00Z', '2026-09-11T10:00:00.000Z'],
    ['a numeric offset', '2026-09-11T13:00:00+03:00', '2026-09-11T10:00:00.000Z'],
    ['microseconds', '2026-09-11T10:00:00.123456Z', '2026-09-11T10:00:00.123Z'],
  ])('accepts an ISO datetime with %s and stores it as UTC', async (_label, clientTimestamp, stored) => {
    const id = `ts-ok-${clientTimestamp}`;
    const res = (await ingest({ events: [event({ event_id: id, session_id: v1, client_timestamp: clientTimestamp })] })).json() as IngestResponse;
    expect(res.results[0]).toMatchObject({ status: 'accepted' });
    const row = app.ctx.db.prepare('SELECT client_timestamp FROM events WHERE event_id = ?').get(id) as { client_timestamp: string };
    expect(row.client_timestamp).toBe(stored);
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

  const stored = (id: string) =>
    app.ctx.db.prepare('SELECT properties_json FROM events WHERE event_id = ?').get(id) as { properties_json: string } | undefined;
  const outcome = (res: IngestResponse) => res.results.map((r) => [r.event_id, r.status, r.reason]);

  it('rejects a raw answer smuggled into answer_kind without costing the rest of the batch', async () => {
    const res = (
      await ingest({
        events: [
          event({ event_id: 'kind-multi', session_id: v1, name: 'answer_submitted', step_id: 'priorities', properties: { answer_kind: 'multi' } }),
          event({ event_id: 'kind-smuggled', session_id: v1, name: 'answer_submitted', step_id: 'work_mode', properties: { answer_kind: 'hybrid, 3 days, compliance' } }),
          event({ event_id: 'kind-null', session_id: v1, name: 'answer_submitted', step_id: 'work_mode', properties: { answer_kind: null } }),
          event({ event_id: 'kind-number', session_id: v1, name: 'answer_submitted', step_id: 'team_size', properties: { answer_kind: 12 } }),
          event({ event_id: 'kind-next', session_id: v1, name: 'step_completed', step_id: 'work_mode', properties: { next_step_id: 'priorities' } }),
        ],
      })
    ).json() as IngestResponse;

    expect(res).toMatchObject({ accepted: 2, duplicates: 0, rejected: 3 });
    expect(outcome(res)).toEqual([
      ['kind-multi', 'accepted', undefined],
      ['kind-smuggled', 'rejected', 'invalid_properties'],
      ['kind-null', 'rejected', 'invalid_properties'],
      ['kind-number', 'rejected', 'invalid_properties'],
      ['kind-next', 'accepted', undefined],
    ]);
    expect(stored('kind-smuggled')).toBeUndefined();
    expect(JSON.parse(stored('kind-multi')!.properties_json)).toEqual({ answer_kind: 'multi' });
  });

  it.each<[string, unknown]>([
    ['an object', { answer: 'hybrid' }],
    ['an array', ['hybrid', 'office']],
    ['a string of 201 characters', 'x'.repeat(201)],
  ])('rejects a whitelisted property holding %s with invalid_properties', async (label, value) => {
    const id = `prop-${label}`;
    const res = (
      await ingest({ events: [event({ event_id: id, session_id: v1, name: 'step_completed', step_id: 'work_mode', properties: { next_step_id: value } })] })
    ).json() as IngestResponse;
    expect(res.results[0]).toEqual({ event_id: id, status: 'rejected', reason: 'invalid_properties' });
    expect(stored(id)).toBeUndefined();
  });

  it('rejects non-finite numbers, which only an in-process caller can send', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = app.ctx.services.ingest.ingestBatch([
        event({ event_id: `nonfinite-${value}`, session_id: v1, properties: { step_type: 'info', visible_step_count: value } }),
      ]);
      expect(res.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_properties' });
    }
  });

  it('accepts null, booleans, finite numbers and strings of up to 200 characters', async () => {
    const res = (
      await ingest({
        events: [
          event({ event_id: 'scalar-view', session_id: v1, properties: { step_type: 'x'.repeat(200), visible_step_index: null, visible_step_count: 7 } }),
          event({ event_id: 'scalar-cta', session_id: v1, name: 'cta_clicked', step_id: 'result', properties: { result_id: null, action: true } }),
        ],
      })
    ).json() as IngestResponse;
    expect(res).toMatchObject({ accepted: 2, rejected: 0 });
  });

  it('still drops non-whitelisted keys silently, whatever they hold', async () => {
    const res = (
      await ingest({
        events: [
          event({
            event_id: 'extra-keys',
            session_id: v1,
            name: 'answer_submitted',
            step_id: 'work_mode',
            properties: { answer_kind: 'single', answer: { mode: 'hybrid', days: [1, 2] }, notes: 'x'.repeat(5000) },
          }),
        ],
      })
    ).json() as IngestResponse;
    expect(res.results[0]).toMatchObject({ status: 'accepted' });
    expect(JSON.parse(stored('extra-keys')!.properties_json)).toEqual({ answer_kind: 'single' });
  });

  it('rejects a step_id outside the session’s own version and variant with unknown_step', async () => {
    const res = (
      await ingest({
        events: [
          event({ event_id: 'step-junk', session_id: v1, step_id: 'junk_step' }),
          event({ event_id: 'step-empty', session_id: v1, step_id: '' }),
          // v3 has security_constraints; this session is on v1.
          event({ event_id: 'step-other-version', session_id: v1, step_id: 'security_constraints' }),
          // v3/B dropped tool_count; the step exists in the config but not in this variant.
          event({ event_id: 'step-other-variant', session_id: v3, step_id: 'tool_count' }),
          event({ event_id: 'step-v3b', session_id: v3, step_id: 'security_constraints' }),
          event({ event_id: 'step-null', session_id: v3, name: 'cta_clicked', step_id: null, properties: { result_id: 'balanced', action: 'expand_recommendation' } }),
          { event_id: 'step-absent', session_id: v3, name: 'cta_clicked', client_timestamp: '2026-09-11T10:00:00.000Z' },
        ],
      })
    ).json() as IngestResponse;

    expect(outcome(res)).toEqual([
      ['step-junk', 'rejected', 'unknown_step'],
      ['step-empty', 'rejected', 'unknown_step'],
      ['step-other-version', 'rejected', 'unknown_step'],
      ['step-other-variant', 'rejected', 'unknown_step'],
      ['step-v3b', 'accepted', undefined],
      ['step-null', 'accepted', undefined],
      ['step-absent', 'accepted', undefined],
    ]);
    const junk = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE step_id IN ('junk_step', '', 'tool_count')").get();
    expect(junk).toEqual({ n: 0 });
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
