import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { ensureSeed } from '../../server/seed';
import { resolveVariant, validateAnswer, isInteractive } from '../../shared/engine';
import type { AnalyticsResponse, IncomingEvent } from '../../shared/api';
import { createRng, deriveSeed } from '../../scripts/traffic/random';
import {
  explainedByConcurrentTraffic,
  generateTraffic,
  pickAnswer,
  reorderBatch,
  NOISE_KINDS,
  type GeneratorSummary,
  type Outcome,
} from '../../scripts/traffic/generator';
import { injectTransport, type HttpMethod, type Transport } from '../../scripts/traffic/transport';
import { loadConfig, loadRawConfig } from '../helpers/configs';

const configsDir = fileURLToPath(new URL('../../configs', import.meta.url));

// Variant assignment is the server's weighted Math.random, which the generator's seed does not
// control. Pinning it keeps these tests deterministic; the determinism tests below count the
// calls to prove that the server is the only caller.
beforeEach(() => {
  vi.spyOn(Math, 'random').mockImplementation(createRng(20260911).next);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const analyticsOf = async (app: FastifyInstance, query = ''): Promise<AnalyticsResponse> => {
  const res = await app.inject({ method: 'GET', url: `/api/analytics${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as AnalyticsResponse;
};

const invariantHolds = (body: AnalyticsResponse) =>
  body.steps.reduce((sum, s) => sum + s.exits, 0) + body.exitsBeforeFirstStep + body.totals.reachedResult ===
  body.totals.started;

/**
 * Sessions whose stored events (rowid = arrival order) run against their client timestamps. The
 * generator's clock only moves forward, so only a shuffled batch can produce one.
 */
function sessionsStoredOutOfOrder(app: FastifyInstance): number {
  const rows = app.ctx.db.prepare('SELECT session_id, client_timestamp FROM events ORDER BY rowid').all() as {
    session_id: string;
    client_timestamp: string;
  }[];
  const latest = new Map<string, string>();
  const outOfOrder = new Set<string>();
  for (const { session_id: session, client_timestamp: at } of rows) {
    const seen = latest.get(session);
    if (seen !== undefined && at < seen) outOfOrder.add(session);
    else latest.set(session, at);
  }
  return outOfOrder.size;
}

async function freshApp(): Promise<FastifyInstance> {
  const app = buildApp();
  await ensureSeed(app, { configsDir });
  return app;
}

describe('seeded PRNG', () => {
  it('repeats the same sequence for the same seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(createRng(43).next()).not.toBe(seqA[0]);
  });

  it('keeps helpers inside their bounds', () => {
    const rng = createRng(1);
    for (let i = 0; i < 500; i++) {
      const n = rng.int(3, 7);
      expect(Number.isInteger(n) && n >= 3 && n <= 7).toBe(true);
    }
    const items = ['a', 'b', 'c', 'd', 'e'];
    const shuffled = rng.shuffle(items);
    expect([...shuffled].sort()).toEqual(items);
    expect(items).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(items).toContain(rng.pick(items));
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
  });

  it('derives a distinct, repeatable seed per session', () => {
    const seeds = Array.from({ length: 1000 }, (_, i) => deriveSeed(42, i));
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds.every((s) => Number.isInteger(s) && s >= 0 && s < 2 ** 32)).toBe(true);
    expect(deriveSeed(42, 7)).toBe(seeds[7]);
    expect(deriveSeed(43, 7)).not.toBe(seeds[7]);
    expect(deriveSeed(0, 0)).not.toBe(deriveSeed(0, 1));
  });
});

describe('pickAnswer', () => {
  it('always produces an answer that passes validateAnswer, for every interactive step of v1 and v3', () => {
    const rng = createRng(5);
    for (const name of ['funnel-v1.json', 'funnel-v3.json'] as const) {
      const config = loadConfig(name);
      for (const variant of Object.keys(config.experiment.variants)) {
        for (const step of resolveVariant(config, variant).steps.filter(isInteractive)) {
          for (let i = 0; i < 200; i++) {
            const answer = pickAnswer(step, rng);
            expect(validateAnswer(step, answer), `${name} ${step.id} ${JSON.stringify(answer)}`).toMatchObject({ ok: true });
          }
        }
      }
    }
  });

  it('skews numbers low but still reaches meeting_hours >= 15 regularly', () => {
    const rng = createRng(9);
    const step = loadConfig('funnel-v3.json').steps.meeting_hours!;
    const values = Array.from({ length: 1000 }, () => pickAnswer(step, rng) as number);
    const heavy = values.filter((v) => v >= 15).length;
    expect(heavy).toBeGreaterThan(250);
    expect(heavy).toBeLessThan(550);
    expect(values.filter((v) => v < 10).length).toBeGreaterThan(heavy);
  });
});

describe('reorderBatch', () => {
  it('always returns the same events in a different order', () => {
    for (let seed = 0; seed < 300; seed++) {
      const rng = createRng(seed);
      for (let length = 2; length <= 6; length++) {
        const batch = Array.from({ length }, (_, id) => ({ id }));
        const out = reorderBatch(batch, rng);
        expect([...out].sort((a, b) => a.id - b.id)).toEqual(batch);
        expect(out.some((event, i) => event !== batch[i]), `seed ${seed}, length ${length}`).toBe(true);
      }
    }
  });
});

describe('generateTraffic on v1', () => {
  it('matches the analytics it produces, through noisy delivery', async () => {
    const app = await freshApp();
    try {
      const lines: string[] = [];
      const summary = await generateTraffic({ transport: injectTransport(app), sessions: 30, seed: 7, log: (l) => lines.push(l) });

      expect(summary.ok).toBe(true);
      expect(summary.sessions).toBe(30);
      expect(summary.actualDelta).toEqual(summary.expected);
      expect(summary.accepted + summary.duplicates + summary.rejected).toBe(summary.eventsSent);
      expect(summary.duplicates).toBeGreaterThan(0);
      expect(summary.rejected).toBeGreaterThan(0);
      for (const kind of NOISE_KINDS) expect(summary.noise[kind], kind).toBeGreaterThan(0);
      // Those counters are the generator's own; what the server answered and stored shows the
      // noise really landed.
      const { noise } = summary;
      // Duplicates are answered but never stored: the table holds exactly what was accepted, plus the
      // one session_started the server writes per session.
      const stored = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
      expect(stored.n).toBe(summary.accepted + summary.sessions);
      expect(summary.rejected).toBeGreaterThanOrEqual(noise.invalidEvent + noise.unknownEvent);
      expect(sessionsStoredOutOfOrder(app)).toBe(noise.shuffled);

      const body = await analyticsOf(app);
      expect(body.totals.started).toBe(30);
      expect(body.totals.reachedResult).toBe(summary.expected.reachedResult);
      expect(body.totals.ctaClicked).toBe(summary.expected.ctaClicked);
      expect(invariantHolds(body)).toBe(true);
      expect(Object.keys(body.byVariant).sort()).toEqual(['A', 'B']);
      expect(body.options.campaigns.length).toBeGreaterThanOrEqual(2);

      // Every session that reached the result asked the server to compute it.
      const withResult = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE result_id IS NOT NULL').get() as { n: number };
      expect(withResult.n).toBe(summary.expected.reachedResult);
      const overrides = app.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE assignment_source = 'override'")
        .get() as { n: number };
      expect(overrides.n).toBe(summary.behaviour.overrides);

      // Only answer kinds reach the events table, never raw answers.
      const answerProps = app.ctx.db
        .prepare("SELECT DISTINCT properties_json AS p FROM events WHERE name = 'answer_submitted'")
        .all() as { p: string }[];
      expect(answerProps.length).toBeGreaterThan(0);
      expect(answerProps.every((r) => Object.keys(JSON.parse(r.p)).join() === 'answer_kind')).toBe(true);

      expect(lines.some((l) => l.includes('OK'))).toBe(true);
      expect(lines.some((l) => l.includes('MISMATCH'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('is deterministic for a seed given the same server variant draws', async () => {
    const run = async (): Promise<{ summary: GeneratorSummary; randomCalls: number }> => {
      const app = await freshApp();
      const random = vi.spyOn(Math, 'random').mockImplementation(createRng(77).next);
      random.mockClear();
      try {
        const summary = await generateTraffic({ transport: injectTransport(app), sessions: 25, seed: 1234 });
        return { summary, randomCalls: random.mock.calls.length };
      } finally {
        await app.close();
      }
    };
    const first = await run();
    const second = await run();
    expect(second.summary.expected).toEqual(first.summary.expected);
    expect(second.summary.noise).toEqual(first.summary.noise);
    expect(second.summary.behaviour).toEqual(first.summary.behaviour);
    expect(first.summary.ok && second.summary.ok).toBe(true);
    // One draw per server-assigned session and nothing else: the generator never calls Math.random,
    // so the stub above is the only thing that is not covered by the seed.
    for (const { summary, randomCalls } of [first, second]) {
      expect(randomCalls).toBe(summary.sessions - summary.behaviour.overrides);
    }
  });

  it('keeps every session plan for a seed when the server draws variants differently', async () => {
    type Row = { variant: string; assignment_source: string; utm_source: string; utm_medium: string; utm_campaign: string };
    const run = async (serverSeed: number): Promise<{ summary: GeneratorSummary; rows: Row[] }> => {
      const app = await freshApp();
      vi.spyOn(Math, 'random').mockImplementation(createRng(serverSeed).next);
      try {
        const summary = await generateTraffic({ transport: injectTransport(app), sessions: 40, seed: 1234 });
        const rows = app.ctx.db
          .prepare('SELECT variant, assignment_source, utm_source, utm_medium, utm_campaign FROM sessions ORDER BY rowid')
          .all() as Row[];
        return { summary, rows };
      } finally {
        await app.close();
      }
    };
    const first = await run(77);
    const second = await run(78);
    // The premise: the server really did assign differently, and the plan includes overrides.
    expect(second.rows.map((r) => r.variant)).not.toEqual(first.rows.map((r) => r.variant));
    expect(first.summary.behaviour.overrides).toBeGreaterThan(0);

    // What the seed controls stays put, session by session.
    const plan = (rows: Row[]) =>
      rows.map((r) => ({
        utm: [r.utm_source, r.utm_medium, r.utm_campaign],
        override: r.assignment_source === 'override' ? r.variant : null,
      }));
    expect(plan(second.rows)).toEqual(plan(first.rows));
    // Every kind applies whenever it is planned, except a shuffle: it needs a batch of two events,
    // so it depends on how far the session got, and that depends on the server's variant.
    const pathFree = (noise: GeneratorSummary['noise']) => NOISE_KINDS.filter((k) => k !== 'shuffled').map((k) => [k, noise[k]]);
    expect(pathFree(second.summary.noise)).toEqual(pathFree(first.summary.noise));
    expect(second.summary.behaviour.overrides).toBe(first.summary.behaviour.overrides);
    expect(second.summary.expected.started).toBe(first.summary.expected.started);
    expect(first.summary.ok && second.summary.ok).toBe(true);
  });
});

describe('generateTraffic on v3', () => {
  it('follows the active config: compliance branch and recommendation_expanded', async () => {
    const app = await freshApp();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') })).statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' })).statusCode).toBe(200);

      const summary = await generateTraffic({ transport: injectTransport(app), sessions: 40, seed: 3 });
      expect(summary.ok).toBe(true);

      const body = await analyticsOf(app, '?version=3');
      expect(body.totals.started).toBe(40);
      expect(body.steps.find((s) => s.stepId === 'security_constraints')!.reached).toBeGreaterThan(0);
      expect(body.steps.find((s) => s.stepId === 'meeting_hours')!.reached).toBeGreaterThan(0);
      expect(invariantHolds(body)).toBe(true);

      const expanded = app.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'recommendation_expanded' AND funnel_version = 3")
        .get() as { n: number };
      expect(expanded.n).toBeGreaterThan(0);
      const onOtherVersions = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE version <> 3').get() as { n: number };
      expect(onOtherVersions.n).toBe(0);
    } finally {
      await app.close();
    }
  });
});

/**
 * A proxy in front of the app. `intrude`: someone else's visitor lands on the first session the
 * generator creates. `dropResults`: how many result_viewed events it eats, so the simulation counts
 * results analytics never sees.
 */
function proxy(app: FastifyInstance, { intrude = false, dropResults = 0 }: { intrude?: boolean; dropResults?: number }): Transport {
  const inner = injectTransport(app);
  let intruded = !intrude;
  let toDrop = dropResults;
  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown) {
      if (!intruded && method === 'POST' && path === '/api/sessions') {
        intruded = true;
        await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      }
      if (toDrop > 0 && method === 'POST' && path === '/api/events') {
        const events = (body as { events: IncomingEvent[] }).events.filter((e) => {
          if (toDrop > 0 && e.name === 'result_viewed') {
            toDrop--;
            return false;
          }
          return true;
        });
        return inner.request<T>(method, path, { events });
      }
      return inner.request<T>(method, path, body);
    },
  };
}

describe('generateTraffic verdict', () => {
  it('names concurrent traffic when analytics grew by sessions the generator did not create', async () => {
    const app = await freshApp();
    try {
      const lines: string[] = [];
      const summary = await generateTraffic({ transport: proxy(app, { intrude: true }), sessions: 5, seed: 11, log: (l) => lines.push(l) });

      expect(summary.ok).toBe(false);
      expect(summary.concurrentSessions).toBe(1);
      expect(summary.concurrentOnly).toBe(true);
      expect(summary.actualDelta.started).toBe(summary.expected.started + 1);
      expect(lines).toContain('Result: MISMATCH — concurrent traffic: +1 sessions not created by the generator');
    } finally {
      await app.close();
    }
  });

  it('does not blame concurrent traffic for a lost result that happened alongside it', async () => {
    const app = await freshApp();
    try {
      const lines: string[] = [];
      const summary = await generateTraffic({
        transport: proxy(app, { intrude: true, dropResults: 1 }),
        sessions: 30,
        seed: 11,
        log: (l) => lines.push(l),
      });

      // The premise: one extra session and one result short.
      expect(summary.actualDelta.started).toBe(summary.expected.started + 1);
      expect(summary.actualDelta.reachedResult).toBe(summary.expected.reachedResult - 1);
      expect(summary.ok).toBe(false);
      expect(summary.concurrentSessions).toBe(1);
      expect(summary.concurrentOnly).toBe(false);
      const verdictLine = lines.find((l) => l.startsWith('Result: '));
      expect(verdictLine).toMatch(/^Result: MISMATCH, analytics differ from the simulation/);
      expect(verdictLine).toContain('+1 sessions not created by the generator');
      expect(lines.some((l) => l.includes('concurrent traffic:'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps the plain mismatch verdict when events go missing', async () => {
    const app = await freshApp();
    try {
      const lines: string[] = [];
      const summary = await generateTraffic({
        transport: proxy(app, { dropResults: Number.POSITIVE_INFINITY }),
        sessions: 30,
        seed: 11,
        log: (l) => lines.push(l),
      });

      expect(summary.expected.reachedResult).toBeGreaterThan(0);
      expect(summary.ok).toBe(false);
      expect(summary.concurrentSessions).toBe(0);
      expect(summary.concurrentOnly).toBe(false);
      expect(lines).toContain('Result: MISMATCH, analytics differ from the simulation');
      expect(lines.some((l) => l.includes('concurrent traffic'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

describe('explainedByConcurrentTraffic', () => {
  const outcome = (total: [number, number, number], byVariant: Record<string, [number, number, number]>): Outcome => {
    const counts = ([started, reachedResult, ctaClicked]: [number, number, number]) => ({ started, reachedResult, ctaClicked });
    return { ...counts(total), byVariant: Object.fromEntries(Object.entries(byVariant).map(([v, c]) => [v, counts(c)])) };
  };
  const expected = outcome([10, 5, 2], { A: [6, 3, 1], B: [4, 2, 1] });

  it('accepts extra sessions, results and clicks, including in a variant the generator never saw', () => {
    expect(explainedByConcurrentTraffic(expected, outcome([11, 6, 3], { A: [7, 4, 2], B: [4, 2, 1] }))).toBe(true);
    expect(explainedByConcurrentTraffic(expected, outcome([11, 5, 2], { A: [6, 3, 1], B: [4, 2, 1], C: [1, 0, 0] }))).toBe(true);
  });

  it('refuses when started did not grow: nobody else came', () => {
    expect(explainedByConcurrentTraffic(expected, outcome([10, 6, 2], { A: [6, 4, 1], B: [4, 2, 1] }))).toBe(false);
  });

  it('refuses when any count is below the simulation, even if the totals hide it', () => {
    expect(explainedByConcurrentTraffic(expected, outcome([11, 4, 2], { A: [7, 2, 1], B: [4, 2, 1] }))).toBe(false);
    // An outside result in B masks a lost result in A at the total level.
    expect(explainedByConcurrentTraffic(expected, outcome([11, 5, 2], { A: [6, 2, 1], B: [5, 3, 1] }))).toBe(false);
    // A variant the simulation expected that analytics did not report at all.
    expect(explainedByConcurrentTraffic(expected, outcome([11, 5, 2], { A: [11, 5, 2] }))).toBe(false);
  });
});
