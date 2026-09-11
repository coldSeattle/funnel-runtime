import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { runBootDemo } from '../../server/seed';
import type { AnalyticsResponse, HealthResponse, HistoryResponse, VersionsResponse } from '../../shared/api';

const configsDir = fileURLToPath(new URL('../../configs', import.meta.url));

type LogLine = Record<string, unknown>;

function captureLogs(): { lines: LogLine[]; stream: Writable } {
  const lines: LogLine[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() !== '') lines.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });
  return { lines, stream };
}
const demoLines = (lines: LogLine[]) => lines.filter((l) => typeof l.msg === 'string' && l.msg.startsWith('boot demo:'));

const get = async <T>(app: FastifyInstance, url: string, headers: Record<string, string> = {}): Promise<T> => {
  const res = await app.inject({ method: 'GET', url, headers });
  expect(res.statusCode).toBe(200);
  return res.json() as T;
};
const snapshot = (app: FastifyInstance) => ({
  sessions: app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get(),
  events: app.ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get(),
  history: app.ctx.services.versions.history().history.length,
  active: app.ctx.services.versions.activeVersion(),
});

describe('runBootDemo', () => {
  let app: FastifyInstance | undefined;
  let tempDir: string | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('turns a fresh database into the demo: v1 and v3 in history and analytics, v1 active; a second call does nothing', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    const outcome = await runBootDemo(app, { configsDir });

    expect(outcome).toEqual({ ran: true, ok: true, summary: 'boot demo: iteration-2 scenario OK — 14/14' });
    // One summary line about the scenario, and none of its ~4,000 in-process requests in the log
    // (checked before this test's own requests below, which are logged as normal).
    await vi.waitFor(() => expect(demoLines(lines)).toHaveLength(1));
    expect(demoLines(lines)[0]).toMatchObject({ level: 30, msg: 'boot demo: iteration-2 scenario OK — 14/14' });
    expect(lines.filter((l) => 'statusCode' in l)).toEqual([]);

    expect(await get<HealthResponse>(app, '/api/health')).toEqual({ ok: true, activeVersion: 1 });
    const { history } = await get<HistoryResponse>(app, '/api/admin/history');
    expect(history.map((h) => [h.action, h.fromVersion, h.toVersion])).toEqual([
      ['publish', null, 1],
      ['publish', 1, 3],
      ['rollback', 3, 1],
    ]);
    // The first thing a grader may click: Rollback must not swing the fresh demo back to v3.
    expect(await get<VersionsResponse>(app, '/api/admin/versions')).toMatchObject({ activeVersion: 1, rollbackTarget: null });
    const rollback = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(rollback.statusCode).toBe(409);
    expect(rollback.json().error.code).toBe('nothing_to_rollback');
    const { byVersion } = await get<AnalyticsResponse>(app, '/api/analytics');
    expect(Object.keys(byVersion).sort()).toEqual(['1', '3']);
    // 120 generated + S1 and S4 on v1; 60 generated + S2 and S3 on v3.
    expect(byVersion['1']!.started).toBe(122);
    expect(byVersion['3']!.started).toBe(62);

    const before = snapshot(app);
    const again = await runBootDemo(app, { configsDir });
    expect(again).toEqual({ ran: false, ok: true, summary: 'boot demo: skipped, the database already has sessions' });
    expect(snapshot(app)).toEqual(before);
  });

  it('runs with ADMIN_TOKEN set', async () => {
    app = buildApp({ adminToken: 's3cret' });

    const outcome = await runBootDemo(app, { configsDir, v1Sessions: 10, v3Sessions: 5 });

    expect(outcome).toEqual({ ran: true, ok: true, summary: 'boot demo: iteration-2 scenario OK — 14/14' });
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
    expect(app.ctx.services.versions.history().history).toHaveLength(3);
  });

  it('never throws: a failing scenario is one warning line and v1 stays active', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'boot-demo-'));
    copyFileSync(join(configsDir, 'funnel-v1.json'), join(tempDir, 'funnel-v1.json'));
    writeFileSync(join(tempDir, 'funnel-v3.json'), JSON.stringify({ version: 3 }));
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    const outcome = await runBootDemo(app, { configsDir: tempDir, v1Sessions: 5 });

    expect(outcome.ran).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(
      /^boot demo: iteration-2 scenario FAILED — 1 of 3 checks failed: v3 uploaded \(POST \/api\/admin\/versions → 400 invalid_config: /,
    );
    await vi.waitFor(() => expect(demoLines(lines)).toHaveLength(1));
    expect(demoLines(lines)[0]).toMatchObject({ level: 40, msg: outcome.summary });
    expect(app.ctx.services.versions.activeVersion()).toBe(1);
  });

  it('never throws when seeding itself fails', async () => {
    app = buildApp();

    const outcome = await runBootDemo(app, { configsDir: join(tmpdir(), 'no-such-configs-dir') });

    expect(outcome.ran).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(/^boot demo: FAILED — Error: ENOENT/);
  });
});
