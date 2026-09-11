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
  app.get('/api/test/client-error', async () => {
    throw Object.assign(new Error('Something the client did'), { statusCode: 400 });
  });
  afterAll(async () => {
    await app.close();
  });

  it('keeps the bad_request fallback for a 4xx that is not a body parse failure', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/client-error' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'bad_request', message: 'Something the client did' });
  });

  it('does not leak the message of an unexpected error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
    expect(res.body).not.toMatch(/sqlite/i);
  });

  it.each(['/api/events', '/api/admin/versions'])('answers a body over the 1 MiB limit on %s with 413 payload_too_large', async (url) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [], padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: { code: 'payload_too_large', message: 'The request body is larger than the 1048576-byte limit' },
    });
  });

  it.each([
    ['/api/events', 'application/xml', '<events/>'],
    ['/api/admin/versions', 'application/x-www-form-urlencoded', 'version=1'],
  ])('answers POST %s with content-type %s with 415 unsupported_media_type', async (url, contentType, payload) => {
    const res = await app.inject({ method: 'POST', url, headers: { 'content-type': contentType }, payload });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({
      error: { code: 'unsupported_media_type', message: 'Unsupported content type: send the body as application/json' },
    });
  });

  it('keeps the message of a deliberate 5xx HttpError', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test/unavailable' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: 'no_active_version', message: 'No funnel version is published yet' });
  });
});
