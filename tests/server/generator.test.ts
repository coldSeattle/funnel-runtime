import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { ensureSeed } from '../../server/seed';
import { resolveVariant, validateAnswer, isInteractive } from '../../shared/engine';
import type { AnalyticsResponse } from '../../shared/api';
import { createRng } from '../../scripts/traffic/random';
import { generateTraffic, pickAnswer, NOISE_KINDS, type GeneratorSummary } from '../../scripts/traffic/generator';
import { injectTransport } from '../../scripts/traffic/transport';
import { loadConfig, loadRawConfig } from '../helpers/configs';

const configsDir = fileURLToPath(new URL('../../configs', import.meta.url));

// Variant assignment is the server's weighted Math.random, which the generator's seed does not
// control. Pinning it keeps these tests deterministic; the generator never calls Math.random.
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

  it('computes identical expected numbers for the same seed on two fresh apps', async () => {
    const run = async (): Promise<GeneratorSummary> => {
      vi.spyOn(Math, 'random').mockImplementation(createRng(77).next);
      const app = await freshApp();
      try {
        return await generateTraffic({ transport: injectTransport(app), sessions: 25, seed: 1234 });
      } finally {
        await app.close();
      }
    };
    const first = await run();
    const second = await run();
    expect(second.expected).toEqual(first.expected);
    expect(second.noise).toEqual(first.noise);
    expect(second.behaviour).toEqual(first.behaviour);
    expect(first.ok && second.ok).toBe(true);
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
