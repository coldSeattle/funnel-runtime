import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import { rollbackTarget } from '../../server/services/versions';
import type { HistoryEntry, HistoryResponse, VersionsResponse } from '../../shared/api';
import { loadRawConfig, makeSyntheticV2 } from '../helpers/configs';

type Step = ['publish', number] | ['rollback'];

/** Replays admin actions as history rows the way the service writes them (rollback to the target). */
function replay(steps: Step[]): Pick<HistoryEntry, 'action' | 'toVersion'>[] {
  const rows: Pick<HistoryEntry, 'action' | 'toVersion'>[] = [];
  for (const step of steps) {
    if (step[0] === 'publish') {
      rows.push({ action: 'publish', toVersion: step[1] });
    } else {
      const target = rollbackTarget(rows);
      if (target === null) throw new Error('nothing to roll back');
      rows.push({ action: 'rollback', toVersion: target });
    }
  }
  return rows;
}

describe('rollbackTarget: undo stack over the history', () => {
  it.each<[string, Step[], number | null]>([
    ['nothing published', [], null],
    ['publish 1', [['publish', 1]], null],
    ['publish 1, publish 3', [['publish', 1], ['publish', 3]], 1],
    ['publish 1, publish 3, rollback', [['publish', 1], ['publish', 3], ['rollback']], null],
    ['publish 1, publish 3, rollback, publish 3', [['publish', 1], ['publish', 3], ['rollback'], ['publish', 3]], 1],
    ['publish 1, publish 3, publish 1', [['publish', 1], ['publish', 3], ['publish', 1]], 3],
    ['publish 1, publish 3, publish 1, rollback', [['publish', 1], ['publish', 3], ['publish', 1], ['rollback']], 1],
    ['publish 1, publish 2, publish 3, rollback', [['publish', 1], ['publish', 2], ['publish', 3], ['rollback']], 1],
  ])('%s → %s', (_label, steps, expected) => {
    expect(rollbackTarget(replay(steps))).toBe(expected);
  });

  it('ignores a publish of the version already on top', () => {
    expect(
      rollbackTarget([
        { action: 'publish', toVersion: 1 },
        { action: 'publish', toVersion: 1 },
      ]),
    ).toBeNull();
  });

  it('re-syncs on a toggle-era rollback row, so the top is always the active version', () => {
    // Written by the old semantics: publish 1, publish 3, rollback 3→1, rollback 1→3 (v3 active).
    const legacy: Pick<HistoryEntry, 'action' | 'toVersion'>[] = [
      { action: 'publish', toVersion: 1 },
      { action: 'publish', toVersion: 3 },
      { action: 'rollback', toVersion: 1 },
      { action: 'rollback', toVersion: 3 },
    ];
    expect(rollbackTarget(legacy)).toBeNull();
    expect(rollbackTarget([...legacy, { action: 'publish', toVersion: 1 }])).toBe(3);
  });
});

describe('POST /api/admin/rollback follows the undo stack', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  const publish = async (version: number) => {
    const res = await app.inject({ method: 'POST', url: `/api/admin/versions/${version}/publish` });
    expect(res.statusCode).toBe(200);
  };
  const rollback = () => app.inject({ method: 'POST', url: '/api/admin/rollback' });
  const versions = async () => (await app.inject({ method: 'GET', url: '/api/admin/versions' })).json() as VersionsResponse;

  it('walks back publish by publish, then refuses, and GET /versions announces each target', async () => {
    for (const payload of [loadRawConfig('funnel-v1.json'), makeSyntheticV2(), loadRawConfig('funnel-v3.json')]) {
      expect((await app.inject({ method: 'POST', url: '/api/admin/versions', payload })).statusCode).toBe(201);
    }
    await publish(1);
    expect((await versions()).rollbackTarget).toBeNull();
    expect((await rollback()).statusCode).toBe(409);

    await publish(3);
    await publish(1);
    expect(await versions()).toMatchObject({ activeVersion: 1, rollbackTarget: 3 });

    expect((await rollback()).json()).toEqual({ activeVersion: 3, fromVersion: 1 });
    expect(await versions()).toMatchObject({ activeVersion: 3, rollbackTarget: 1 });

    expect((await rollback()).json()).toEqual({ activeVersion: 1, fromVersion: 3 });
    expect(await versions()).toMatchObject({ activeVersion: 1, rollbackTarget: null });

    const refused = await rollback();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('nothing_to_rollback');

    await publish(2);
    await publish(3);
    expect(await versions()).toMatchObject({ activeVersion: 3, rollbackTarget: 2 });
    expect((await rollback()).json()).toEqual({ activeVersion: 2, fromVersion: 3 });
    expect((await rollback()).json()).toEqual({ activeVersion: 1, fromVersion: 2 });
    expect((await rollback()).statusCode).toBe(409);

    // History rows keep their shape: rollback rows record where they came from and went to.
    const { history } = (await app.inject({ method: 'GET', url: '/api/admin/history' })).json() as HistoryResponse;
    expect(history.map((h) => [h.action, h.fromVersion, h.toVersion])).toEqual([
      ['publish', null, 1],
      ['publish', 1, 3],
      ['publish', 3, 1],
      ['rollback', 1, 3],
      ['rollback', 3, 1],
      ['publish', 1, 2],
      ['publish', 2, 3],
      ['rollback', 3, 2],
      ['rollback', 2, 1],
    ]);
  });
});

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
    expect(await list()).toEqual({ funnelId: null, activeVersion: null, rollbackTarget: null, versions: [] });
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

  it.each<[string, (raw: Record<string, any>) => void, (string | number)[]]>([
    ['a variant override that breaks a step', (r) => (r.experiment.variants.B.stepOverrides.intro = { type: 'banana' }), ['experiment', 'variants', 'B', 'stepOverrides', 'intro', 'type']],
    ['a TTL that would make expires_at an invalid date', (r) => (r.session.ttlHours = 1e12), ['session', 'ttlHours']],
  ])('rejects %s with 400 invalid_config, so new sessions can never hit it', async (_label, mutate, path) => {
    const raw = loadRawConfig('funnel-v1.json') as Record<string, any>;
    raw.version = 9;
    mutate(raw);
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions', payload: raw });
    expect(res.statusCode).toBe(400);
    const err = res.json().error as { code: string; details: { path: (string | number)[] }[] };
    expect(err.code).toBe('invalid_config');
    expect(err.details.map((d) => d.path)).toContainEqual(path);
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

  it('does not toggle: a second rollback has nothing to undo and leaves v1 active', async () => {
    expect((await list()).rollbackTarget).toBeNull();
    const res = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_rollback');

    const body = await list();
    expect(body.activeVersion).toBe(1);
    const { history } = (await app.inject({ method: 'GET', url: '/api/admin/history' })).json() as HistoryResponse;
    expect(history).toHaveLength(3);
  });

  it('re-publishing a version keeps its first published_at', async () => {
    const v3Before = (await list()).versions.find((v) => v.version === 3)!.publishedAt;
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/3/publish' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activeVersion: 3, fromVersion: 1 });
    const body = await list();
    const v3 = body.versions.find((v) => v.version === 3)!;
    expect(v3.status).toBe('active');
    expect(v3.publishedAt).toBe(v3Before);
    expect(body.rollbackTarget).toBe(1);
  });

  it('accepts bodiless admin POSTs sent with a JSON content-type, as fetch wrappers often do', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/rollback',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ activeVersion: 1, fromVersion: 3 });
  });

  it('answers a syntactically broken JSON body with 400 invalid_body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/versions',
      headers: { 'content-type': 'application/json' },
      payload: '{"version": 1,',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('answers a prototype-poisoning JSON body with 400 invalid_body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/versions',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__": {"polluted": true}}',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
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

describe('admin on an empty database', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('404s publishing a version before anything is uploaded', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('version_not_found');
  });

  it('404s on a version path segment that is not a number', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/versions/latest/publish' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('version_not_found');
  });

  it('409s on rollback before anything is uploaded', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_rollback');
  });

  it('returns an empty history', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/history' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ history: [] });
  });

  it('409s on rollback right after the first publish (from_version is null)', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/versions', payload: loadRawConfig('funnel-v1.json') });
    await app.inject({ method: 'POST', url: '/api/admin/versions/1/publish' });
    const res = await app.inject({ method: 'POST', url: '/api/admin/rollback' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('nothing_to_rollback');
  });
});
