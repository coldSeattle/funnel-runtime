import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import { ensureSeed } from '../../server/seed';
import { runIteration2Check, type Iteration2Options } from '../../scripts/iteration2-check';
import { injectTransport } from '../../scripts/traffic/transport';

const configsDir = fileURLToPath(new URL('../../configs', import.meta.url));

const ALL_STEPS = [
  'precondition',
  'old session starts on v1',
  'v3 uploaded',
  'v3 published',
  'old session continues on v1',
  'new event is version-scoped',
  'new session starts on v3 (variant B)',
  'v3 variant A keeps tool_count',
  'synthetic v3 traffic',
  'analytics sees both versions',
  'rollback',
  'v3 session keeps working after rollback',
  'new sessions return to v1',
  'no analytics loss',
];
const WITHOUT_TRAFFIC = ALL_STEPS.filter((s) => s !== 'synthetic v3 traffic');

async function freshApp(adminToken: string | null = null): Promise<FastifyInstance> {
  const app = buildApp({ adminToken });
  await ensureSeed(app, { configsDir });
  return app;
}

describe('iteration 2 acceptance check', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const run = async (opts: Partial<Iteration2Options> = {}) => {
    const lines: string[] = [];
    const result = await runIteration2Check({ transport: injectTransport(app), configsDir, log: (l) => lines.push(l), ...opts });
    return { ...result, lines };
  };
  const history = () => app.ctx.services.versions.history().history.map((h) => `${h.action} ${h.fromVersion}→${h.toVersion}`);
  const sessionRow = (id: string | undefined) =>
    app.ctx.db.prepare('SELECT version, variant, assignment_source, utm_campaign, result_id FROM sessions WHERE id = ?').get(id);

  it('publishes v3, proves old and new sessions, rolls back and loses nothing', async () => {
    const { ok, checks, sessions, lines } = await run({ traffic: 20, seed: 3 });

    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(ok).toBe(true);
    expect(checks.map((c) => c.step)).toEqual(ALL_STEPS);
    expect(lines.filter((l) => /^✓ \d\d:\d\d:\d\d .+ — .+/.test(l))).toHaveLength(14);
    expect(lines.some((l) => l.startsWith('✗'))).toBe(false);
    expect(lines.at(-1)).toBe('Result: OK — 14/14 checks passed');

    // What the database says afterwards, independently of the script's own checks.
    expect(Object.keys(sessions)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(sessionRow(sessions.S1)).toMatchObject({ version: 1, variant: 'A', result_id: 'async_native', utm_campaign: 'iteration2_check' });
    expect(sessionRow(sessions.S2)).toMatchObject({ version: 3, variant: 'B', result_id: 'regulated_scale', assignment_source: 'override' });
    expect(sessionRow(sessions.S3)).toMatchObject({ version: 3, variant: 'A' });
    expect(sessionRow(sessions.S4)).toMatchObject({ version: 1, variant: 'A' });
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1']);

    // The new event exists only on v3; the one S1 tried on v1 was refused, not stored.
    const expanded = app.ctx.db
      .prepare("SELECT DISTINCT funnel_version AS v FROM events WHERE name = 'recommendation_expanded'")
      .all() as { v: number }[];
    expect(expanded.map((r) => r.v)).toEqual([3]);
    // 20 generated sessions plus S2 and S3 on v3.
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE version = 3').get()).toEqual({ n: 22 });
  });

  it('passes again on the same database: v3 is already stored, publish and rollback work again', async () => {
    expect((await run()).ok).toBe(true);
    const second = await run();

    expect(second.checks.filter((c) => !c.ok)).toEqual([]);
    expect(second.checks.map((c) => c.step)).toEqual(WITHOUT_TRAFFIC);
    expect(second.checks.find((c) => c.step === 'v3 uploaded')!.detail).toContain('409 version_exists');
    expect(second.lines.some((l) => l.includes('synthetic v3 traffic skipped'))).toBe(true);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1', 'publish 1→3', 'rollback 3→1']);
  });

  it('refuses to start while v3 is active and changes nothing', async () => {
    const kept = await run({ keepV3: true });
    expect(kept.ok).toBe(true);
    expect(kept.checks.map((c) => c.step)).toEqual(WITHOUT_TRAFFIC.slice(0, WITHOUT_TRAFFIC.indexOf('rollback')));
    expect(app.ctx.services.versions.activeVersion()).toBe(3);
    const sessionsBefore = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get();

    const blocked = await run();
    expect(blocked.ok).toBe(false);
    expect(blocked.checks).toHaveLength(1);
    expect(blocked.checks[0]).toMatchObject({ step: 'precondition', ok: false });
    expect(blocked.checks[0]!.detail).toMatch(/v3 is already active: roll back first/);
    expect(blocked.lines.filter((l) => l.startsWith('✗ '))).toHaveLength(1);
    expect(blocked.lines.at(-1)).toBe('Result: FAILED — 1 of 1 checks failed: precondition');

    expect(app.ctx.services.versions.activeVersion()).toBe(3);
    expect(app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual(sessionsBefore);
  });

  it('stamps every check with the given clock, printed as UTC HH:MM:SS', async () => {
    const at = new Date('2026-09-12T08:15:30.000Z');
    const { checks, lines } = await run({ now: () => at });
    expect(checks.every((c) => c.at === '2026-09-12T08:15:30.000Z')).toBe(true);
    expect(lines.filter((l) => l.startsWith('✓ 08:15:30 '))).toHaveLength(checks.length);
  });
});

describe('iteration 2 acceptance check with ADMIN_TOKEN', () => {
  it('stops at the precondition without the token and passes with it', async () => {
    const app = await freshApp('s3cret');
    try {
      const without = await runIteration2Check({ transport: injectTransport(app), configsDir });
      expect(without.ok).toBe(false);
      expect(without.checks).toHaveLength(1);
      expect(without.checks[0]!.detail).toContain('401 unauthorized');
      expect(without.checks[0]!.detail).toContain('--admin-token');

      const withToken = await runIteration2Check({ transport: injectTransport(app, { adminToken: 's3cret' }), configsDir });
      expect(withToken.checks.filter((c) => !c.ok)).toEqual([]);
      expect(withToken.ok).toBe(true);
    } finally {
      await app.close();
    }
  });
});
