import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';

describe('app basics', () => {
  const app = buildApp();
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health reports no active version on an empty database', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, activeVersion: null });
  });

  it('unknown API routes return a JSON error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});
