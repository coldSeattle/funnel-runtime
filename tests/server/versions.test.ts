import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import type { HistoryResponse, VersionsResponse } from '../../shared/api';
import { loadRawConfig, makeSyntheticV2 } from '../helpers/configs';

describe('admin versions: upload, publish, rollback, history', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  const list = async (): Promise<VersionsResponse> => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/versions' });
    expect(res.statusCode).toBe(200);
    return res.json() as VersionsResponse;
  };

  it('reports an empty funnel before anything is uploaded', async () => {
    expect(await list()).toEqual({ funnelId: null, activeVersion: null, versions: [] });
  });

  it('uploads v1 as a draft', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ version: 1 });

    const body = await list();
    expect(body.funnelId).toBe('workstyle-planner');
    expect(body.activeVersion).toBeNull();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      version: 1,
      title: "Find your team's operating style",
      status: 'draft',
      publishedAt: null,
      sessions: 0,
    });
  });

  it('rejects an invalid config with 400 and zod issue details', async () => {
    const broken = loadRawConfig('funnel-v1.json') as Record<string, any>;
    broken.version = 9;
    broken.experiment.variants.A.stepSequence = ['intro', 'does_not_exist', 'result'];
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: broken });
    expect(res.statusCode).toBe(400);
    const err = res.json().error;
    expect(err.code).toBe('invalid_config');
    expect(Array.isArray(err.details)).toBe(true);
    expect(err.details.length).toBeGreaterThan(0);
    expect((await list()).versions).toHaveLength(1);
  });

  it('rejects a duplicate version number with 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('version_exists');
  });

  it('rejects a config for a different funnel with 409', async () => {
    const other = loadRawConfig('funnel-v1.json') as Record<string, any>;
    other.funnelId = 'another-funnel';
    other.version = 7;
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: other });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('funnel_mismatch');
  });

  it('404s when publishing a version that was never uploaded', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/42/publish' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('version_not_found');
  });

  it('409s on rollback while there is no history', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_rollback');
  });

  it('publishes v1 and makes it active', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activeVersion: 1 });

    const body = await list();
    expect(body.activeVersion).toBe(1);
    expect(body.versions[0]!.status).toBe('active');
    expect(body.versions[0]!.publishedAt).not.toBeNull();

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, activeVersion: 1 });
  });

  it('409s when publishing the already active version', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_active');
  });

  it('uploads and publishes v3: v1 becomes published, v3 active', async () => {
    const upload = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v3.json') });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toEqual({ version: 3 });

    const publish = await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });
    expect(publish.statusCode).toBe(200);

    const body = await list();
    expect(body.activeVersion).toBe(3);
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'published'],
      [3, 'active'],
    ]);
  });

  it('keeps an uploaded but never published version in draft', async () => {
    const upload = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: makeSyntheticV2() });
    expect(upload.statusCode).toBe(201);
    const body = await list();
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'published'],
      [2, 'draft'],
      [3, 'active'],
    ]);
  });

  it('rolls back to the previously active version', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activeVersion: 1, fromVersion: 3 });

    const body = await list();
    expect(body.activeVersion).toBe(1);
    expect(body.versions.map((v) => [v.version, v.status])).toEqual([
      [1, 'active'],
      [2, 'draft'],
      [3, 'published'],
    ]);
  });

  it('records publish and rollback in the history', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/history' });
    expect(res.statusCode).toBe(200);
    const { history } = res.json() as HistoryResponse;
    expect(history.map((h) => [h.action, h.fromVersion, h.toVersion])).toEqual([
      ['publish', null, 1],
      ['publish', 1, 3],
      ['rollback', 3, 1],
    ]);
    expect(history[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('admin auth', () => {
  const app = buildApp({ adminToken: 's3cret' });
  afterAll(async () => {
    await app.close();
  });

  it('rejects admin requests without the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/versions' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('accepts admin requests with the token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/versions', headers: { 'x-admin-token': 's3cret' } });
    expect(res.statusCode).toBe(200);
  });

  it('leaves public routes open', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
