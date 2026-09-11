import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { ensureSeed, resolveConfigsDir } from '../../server/seed';
import type { HistoryResponse, VersionsResponse } from '../../shared/api';
import { loadRawConfig } from '../helpers/configs';

const configsDir = fileURLToPath(new URL('../../configs', import.meta.url));
const repoDir = fileURLToPath(new URL('../..', import.meta.url));

describe('resolveConfigsDir', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('finds configs/ beside the bundle directory, whatever the working directory is', () => {
    root = mkdtempSync(join(tmpdir(), 'configs-dir-'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'configs'));
    writeFileSync(join(root, 'configs', 'funnel-v1.json'), '{}');
    expect(resolveConfigsDir(join(root, 'dist'), '/somewhere/else')).toBe(join(root, 'configs'));
  });

  it('falls back to the working directory when there is no configs/ beside the bundle', () => {
    root = mkdtempSync(join(tmpdir(), 'configs-dir-'));
    mkdirSync(join(root, 'dist'));
    expect(resolveConfigsDir(join(root, 'dist'), '/srv/app')).toBe(join('/srv/app', 'configs'));
  });

  it('resolves this repository’s configs/ from dist/ (bundle) and server/ (tsx)', () => {
    for (const here of [join(repoDir, 'dist'), join(repoDir, 'server')]) {
      expect(resolveConfigsDir(here, '/nowhere')).toBe(configsDir);
    }
  });
});

const versionsOf = async (app: FastifyInstance, headers: Record<string, string> = {}) =>
  (await app.inject({ method: 'GET', url: '/api/admin/versions', headers })).json() as VersionsResponse;

describe('ensureSeed on an empty database', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('uploads and publishes v1, and is idempotent', async () => {
    await ensureSeed(app, { configsDir });
    await ensureSeed(app, { configsDir });

    const body = await versionsOf(app);
    expect(body.activeVersion).toBe(1);
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([[1, 'active']]);

    const { history } = (await app.inject({ method: 'GET', url: '/api/admin/history' })).json() as HistoryResponse;
    expect(history.map((h) => [h.action, h.fromVersion, h.toVersion])).toEqual([['publish', null, 1]]);
  });
});

describe('ensureSeed with versions already stored', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('leaves the existing funnel alone', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });

    await ensureSeed(app, { configsDir });

    const body = await versionsOf(app);
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([[3, 'active']]);
  });
});

describe('ensureSeed traffic hook', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('runs only while there are no sessions, after v1 is live', async () => {
    const runTraffic = vi.fn(async (target: FastifyInstance) => {
      const res = await target.inject({ method: 'POST', url: '/api/sessions', payload: {} });
      expect(res.statusCode).toBe(201);
    });

    await ensureSeed(app, { configsDir, runTraffic });
    expect(runTraffic).toHaveBeenCalledTimes(1);
    expect(runTraffic).toHaveBeenCalledWith(app);

    await ensureSeed(app, { configsDir, runTraffic });
    expect(runTraffic).toHaveBeenCalledTimes(1);
  });
});

describe('ensureSeed with an admin token', () => {
  const app = buildApp({ adminToken: 'secret' });
  afterAll(async () => {
    await app.close();
  });

  it('seeds through the services, not the guarded HTTP routes', async () => {
    await ensureSeed(app, { configsDir });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, activeVersion: 1 });
    expect((await versionsOf(app, { 'x-admin-token': 'secret' })).activeVersion).toBe(1);
  });
});
