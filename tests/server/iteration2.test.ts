import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { ensureSeed } from '../../server/seed';
import type { IncomingEvent, IngestResponse, SessionResponse } from '../../shared/api';
import { runIteration2Check, type Iteration2Check, type Iteration2Options } from '../../scripts/iteration2/check';
import { createRng } from '../../scripts/traffic/random';
import { injectTransport, type HttpMethod, type Transport, type TransportResponse } from '../../scripts/traffic/transport';

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

type Forward = () => Promise<TransportResponse<unknown>>;
type Hook = (method: HttpMethod, path: string, body: unknown, forward: Forward) => Promise<TransportResponse<unknown>>;

/** The in-process transport with a hook in front: it can answer instead of the server, or after it. */
function tampered(app: FastifyInstance, hook: Hook): Transport {
  const inner = injectTransport(app);
  return {
    request: async <T>(method: HttpMethod, path: string, body?: unknown) =>
      (await hook(method, path, body, () => inner.request<unknown>(method, path, body))) as TransportResponse<T>,
  };
}
const serverError: TransportResponse<unknown> = { status: 500, body: { error: { code: 'internal', message: 'Internal error' } } };
const isRollback = (method: HttpMethod, path: string) => method === 'POST' && path === '/api/admin/rollback';
const startsVariantB = (method: HttpMethod, path: string, body: unknown) =>
  method === 'POST' && path === '/api/sessions' && (body as { query?: { variant?: string } } | undefined)?.query?.variant === 'B';

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
    app.ctx.db
      .prepare('SELECT version, variant, assignment_source, utm_campaign, result_id, current_step_id, answers_json FROM sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
  const detailOf = (checks: Iteration2Check[], step: string) => checks.find((c) => c.step === step)!.detail;

  it('publishes v3, proves old and new sessions, rolls back and loses nothing', async () => {
    const rejections: string[] = [];
    const recording = tampered(app, async (method, path, _body, forward) => {
      const res = await forward();
      if (method === 'POST' && path === '/api/events') {
        for (const r of (res.body as IngestResponse).results) if (r.status === 'rejected') rejections.push(r.reason ?? '');
      }
      return res;
    });
    const { ok, checks, sessions, lines, recovery } = await run({ traffic: 20, seed: 3, transport: recording });

    expect(checks.filter((c) => !c.ok)).toEqual([]);
    // Ingest refuses only what the run means it to: check 6's v3-only event on v1 and the generator's
    // planted noise. Every real event passes the property and step checks.
    expect([...new Set(rejections)].sort()).toEqual(['invalid_shape', 'unknown_event']);
    expect(ok).toBe(true);
    expect(recovery).toBeUndefined();
    expect(checks.map((c) => c.step)).toEqual(ALL_STEPS);
    expect(lines.filter((l) => /^✓ \d\d:\d\d:\d\d .+ — .+/.test(l))).toHaveLength(14);
    expect(lines.some((l) => l.startsWith('✗') || l.startsWith('⚠'))).toBe(false);
    expect(lines.at(-1)).toBe('Result: OK — 14/14 checks passed');
    // Check 10 counts this run's sessions from the baseline taken at the precondition.
    expect(detailOf(checks, 'precondition')).toContain('analytics baseline v1 0, v3 0 sessions started');
    expect(detailOf(checks, 'analytics sees both versions')).toContain('since the precondition v1 +1, v3 +22 (this run: S2, S3 and 20 generated)');

    // What the database says afterwards, independently of the script's own checks.
    expect(Object.keys(sessions)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(sessionRow(sessions.S1)).toMatchObject({ version: 1, variant: 'A', result_id: 'async_native', utm_campaign: 'iteration2_check' });
    expect(sessionRow(sessions.S2)).toMatchObject({ version: 3, variant: 'B', result_id: 'regulated_scale', assignment_source: 'override' });
    expect(sessionRow(sessions.S4)).toMatchObject({ version: 1, variant: 'A' });
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1']);

    // S3 stopped mid-funnel on v3 and took one more step after the rollback.
    expect(detailOf(checks, 'v3 variant A keeps tool_count')).toContain('intro → team_size answered, left mid-funnel on work_mode');
    expect(detailOf(checks, 'v3 session keeps working after rollback')).toContain(
      'S3 (mid-funnel): GET → config v3; answered work_mode → PUT state 200, now on priorities; step_viewed, answer_submitted, step_completed accepted',
    );
    const s3 = sessionRow(sessions.S3)!;
    expect(s3).toMatchObject({ version: 3, variant: 'A', current_step_id: 'priorities', result_id: null });
    expect(JSON.parse(s3.answers_json as string)).toMatchObject({ team_size: 12, work_mode: 'remote' });
    const rolledBackAt = app.ctx.services.versions.history().history.at(-1)!.at;
    const afterRollback = app.ctx.db
      .prepare("SELECT name, funnel_version AS v FROM events WHERE session_id = ? AND step_id = 'work_mode' AND server_timestamp >= ? ORDER BY rowid")
      .all(sessions.S3, rolledBackAt);
    expect(afterRollback).toEqual([
      { name: 'step_viewed', v: 3 },
      { name: 'answer_submitted', v: 3 },
      { name: 'step_completed', v: 3 },
    ]);

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
    expect(detailOf(second.checks, 'v3 uploaded')).toContain('409 version_exists');
    expect(detailOf(second.checks, 'v3 uploaded')).toContain('matches configs/funnel-v3.json');
    expect(detailOf(second.checks, 'precondition')).toContain('analytics baseline v1 2, v3 2 sessions started');
    expect(detailOf(second.checks, 'analytics sees both versions')).toContain('since the precondition v1 +1, v3 +2');
    expect(second.lines.some((l) => l.includes('synthetic v3 traffic skipped'))).toBe(true);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1', 'publish 1→3', 'rollback 3→1']);
  });

  it('fails check 10 on a rerun when this run’s v3 sessions never reach analytics', async () => {
    expect((await run()).ok).toBe(true);

    // Analytics stuck at what the first run left: v1 and v3 are both there, nothing from this run.
    let frozen: TransportResponse<unknown> | undefined;
    const transport = tampered(app, async (method, path, _body, forward) => {
      if (method !== 'GET' || path !== '/api/analytics') return forward();
      frozen ??= await forward();
      return frozen;
    });
    const second = await run({ transport });

    expect(second.ok).toBe(false);
    expect(second.checks.find((c) => c.step === 'analytics sees both versions')).toMatchObject({
      ok: false,
      detail: 'v3 started 2 → 2 (+0) since the precondition, expected at least +2 for S2, S3',
    });
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
  });

  it('refuses to publish a stored v3 that is not configs/funnel-v3.json', async () => {
    const file = JSON.parse(readFileSync(`${configsDir}/funnel-v3.json`, 'utf8')) as Record<string, unknown>;
    const other = { ...file, title: 'Somebody else’s v3' };
    expect((await app.inject({ method: 'POST', url: '/api/admin/versions', payload: other })).statusCode).toBe(201);

    const { ok, checks, recovery } = await run();

    expect(ok).toBe(false);
    expect(checks.map((c) => c.step)).toEqual(ALL_STEPS.slice(0, 3));
    expect(checks[2]!.ok).toBe(false);
    expect(checks[2]!.detail).toBe(
      `the stored v3 is not configs/funnel-v3.json: stored title "Somebody else’s v3" / release note ${JSON.stringify(file.releaseNote)}, ` +
        `the file has ${JSON.stringify(file.title)} / ${JSON.stringify(file.releaseNote)}; not publishing it (compare the stored v3 in /admin with the file)`,
    );
    expect(recovery).toBeUndefined();
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
    expect(history()).toEqual(['publish null→1']);
  });

  it('refuses to start while v3 is active and changes nothing', async () => {
    const kept = await run({ keepV3: true });
    expect(kept.ok).toBe(true);
    expect(kept.recovery).toBeUndefined();
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

describe('iteration 2 acceptance check: failures after the publish never leave v3 active', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const run = async (transport: Transport, opts: Partial<Iteration2Options> = {}) => {
    const lines: string[] = [];
    const result = await runIteration2Check({ transport, configsDir, log: (l) => lines.push(l), ...opts });
    return { ...result, lines };
  };
  const failedSteps = (checks: Iteration2Check[]) => checks.filter((c) => !c.ok).map((c) => c.step);
  const active = () => app.ctx.services.versions.activeVersion();
  const history = () => app.ctx.services.versions.history().history.map((h) => `${h.action} ${h.fromVersion}→${h.toVersion}`);

  it('a broken check 7 fails the run and it still ends on v1', async () => {
    const transport = tampered(app, (method, path, body, forward) => (startsVariantB(method, path, body) ? Promise.resolve(serverError) : forward()));
    const { ok, checks, lines, recovery } = await run(transport);

    expect(ok).toBe(false);
    expect(checks.find((c) => c.step === 'new session starts on v3 (variant B)')).toMatchObject({
      ok: false,
      detail: 'POST /api/sessions → 500 internal: Internal error',
    });
    expect(checks.find((c) => c.step === 'rollback')!.ok).toBe(true);
    expect(recovery).toBe('v1_active');
    expect(lines).toContain('  v1 is active after the failure (GET /api/admin/versions); nothing to roll back');
    expect(lines.at(-1)).toMatch(/^Result: FAILED — /);
    expect(active()).toBe(1);
  });

  it('rolls back itself when the rollback check fails', async () => {
    let refused = false;
    const transport = tampered(app, (method, path, _body, forward) => {
      if (isRollback(method, path) && !refused) {
        refused = true;
        return Promise.resolve(serverError);
      }
      return forward();
    });
    const { ok, checks, lines, recovery } = await run(transport);

    expect(ok).toBe(false);
    // S2 and S3 are pinned to v3 either way; with v3 still active S4 lands on v3 and v3 grows.
    expect(failedSteps(checks)).toEqual(['rollback', 'new sessions return to v1', 'no analytics loss']);
    expect(recovery).toBe('rolled_back');
    const warning = lines.indexOf('⚠ rolled back to v1 after a failure');
    expect(warning).toBeGreaterThan(-1);
    expect(lines.slice(warning + 1).map((l) => l.split(':')[0])).toEqual(['Sessions', 'Result']);
    expect(active()).toBe(1);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1']);
  });

  it('rolls back a publish that landed although its response was lost', async () => {
    const transport = tampered(app, async (method, path, _body, forward) => {
      if (method === 'POST' && path === '/api/admin/versions/3/publish') {
        await forward();
        return { status: 502, body: 'Bad Gateway' };
      }
      return forward();
    });
    const { ok, checks, lines, recovery } = await run(transport);

    expect(ok).toBe(false);
    expect(checks.map((c) => c.step)).toEqual(ALL_STEPS.slice(0, 4));
    expect(checks[3]).toMatchObject({ step: 'v3 published', ok: false, detail: 'POST /api/admin/versions/3/publish → 502 "Bad Gateway"' });
    expect(recovery).toBe('rolled_back');
    expect(lines).toContain('⚠ rolled back to v1 after a failure');
    expect(active()).toBe(1);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1']);
  });

  it('says v3 may still be active when every rollback fails', async () => {
    const transport = tampered(app, (method, path, _body, forward) => (isRollback(method, path) ? Promise.resolve(serverError) : forward()));
    const { ok, lines, recovery } = await run(transport);

    expect(ok).toBe(false);
    expect(recovery).toBe('unresolved');
    expect(lines).toContain(
      '⚠ v3 may still be active — roll back in /admin (the automatic rollback failed: POST /api/admin/rollback → 500 internal: Internal error)',
    );
    expect(active()).toBe(3);
  });

  it('does not roll back with keepV3, and says so', async () => {
    const transport = tampered(app, (method, path, body, forward) => (startsVariantB(method, path, body) ? Promise.resolve(serverError) : forward()));
    const { ok, lines, recovery } = await run(transport, { keepV3: true });

    expect(ok).toBe(false);
    expect(recovery).toBe('unresolved');
    expect(lines).toContain('⚠ v3 may still be active — roll back in /admin (--keep-v3: no automatic rollback)');
    expect(active()).toBe(3);
    expect(history()).toEqual(['publish null→1', 'publish 1→3']);
  });

  it('rolls back when the run throws after the publish', async () => {
    const lines: string[] = [];
    const log = (line: string) => {
      lines.push(line);
      if (line.includes('new session starts on v3')) throw new Error('log sink broke');
    };

    await expect(runIteration2Check({ transport: injectTransport(app), configsDir, log })).rejects.toThrow('log sink broke');
    expect(lines).toContain('⚠ rolled back to v1 after a failure');
    expect(active()).toBe(1);
    expect(history()).toEqual(['publish null→1', 'publish 1→3', 'rollback 3→1']);
  });
});

describe('iteration 2 acceptance check: synthetic traffic failure detail', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await freshApp();
    // Pinned server variant draws, so the generator's sessions reach the result the same way every run.
    vi.spyOn(Math, 'random').mockImplementation(createRng(20260911).next);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  /**
   * On the generator's first session someone else's visitor lands; `dropResult` also eats the first
   * result_viewed of a generator session. The QA sessions S1–S4 pass through untouched.
   */
  const trafficCheck = async (dropResult: boolean): Promise<Iteration2Check> => {
    const inner = injectTransport(app);
    const generated = new Set<string>();
    let intruded = false;
    let dropped = !dropResult;
    const transport: Transport = {
      async request<T>(method: HttpMethod, path: string, body?: unknown) {
        const campaign = (body as { query?: Record<string, string> } | undefined)?.query?.utm_campaign;
        const fromGenerator = method === 'POST' && path === '/api/sessions' && campaign !== 'iteration2_check';
        if (fromGenerator && !intruded) {
          intruded = true;
          await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
        }
        if (!dropped && method === 'POST' && path === '/api/events') {
          const events = (body as { events: IncomingEvent[] }).events.filter((e) => {
            if (!dropped && e.name === 'result_viewed' && generated.has(e.session_id)) {
              dropped = true;
              return false;
            }
            return true;
          });
          return inner.request<T>(method, path, { events });
        }
        const res = await inner.request<T>(method, path, body);
        if (fromGenerator) generated.add((res.body as SessionResponse).session.id);
        return res;
      },
    };
    const { checks } = await runIteration2Check({ transport, configsDir, traffic: 20, seed: 3 });
    expect(dropped).toBe(true);
    return checks.find((c) => c.step === 'synthetic v3 traffic')!;
  };

  it('names concurrent traffic when it explains the whole difference', async () => {
    const check = await trafficCheck(false);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('analytics moved by 1 sessions the generator did not create (concurrent traffic)');
  });

  it('points at the table when a result is also lost, instead of blaming the extra session', async () => {
    const check = await trafficCheck(true);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^the analytics delta differs from the simulation \(table above\)/);
    expect(check.detail).toContain('1 sessions the generator did not create cannot explain counts below it');
    expect(check.detail).not.toContain('(concurrent traffic)');
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

describe('iteration 2 CLI module', () => {
  it('re-exports the check, and importing it does not start a run', async () => {
    const cli = await import('../../scripts/iteration2-check');
    expect(cli.runIteration2Check).toBe(runIteration2Check);
  });
});
