import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';
import { HttpError } from '../../server/errors';

describe('error handler', () => {
  const app = buildApp();
  app.get('/api/test/crash', async () => {
    throw new Error('SQLite3 can only bind numbers, strings, bigints, buffers, and null');
  });
  app.get('/api/test/unavailable', async () => {
    throw new HttpError(503, 'no_active_version', 'No funnel version is published yet');
  });
  afterAll(async () => {
    await app.close();
  });

  it('does not leak the message of an unexpected error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
    expect(res.body).not.toMatch(/sqlite/i);
  });

  it('keeps the message of a deliberate 5xx HttpError', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/unavailable' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'no_active_version', message: 'No funnel version is published yet' });
  });
});
