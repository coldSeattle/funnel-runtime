import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../server/app';

describe('SPA fallback with a static dir', () => {
  const staticDir = mkdtempSync(join(tmpdir(), 'funnel-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>spa</title>');
  const app = buildApp({ staticDir });

  afterAll(async () => {
    await app.close();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it.each(['/api', '/api?x=1', '/api/', '/api/nope', '/api/nope?x=1'])('answers GET %s with a JSON 404', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().error.code).toBe('not_found');
  });

  it.each(['/', '/dashboard', '/dashboard?variant=B', '/apiary'])('serves index.html for GET %s', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<title>spa</title>');
  });
});
