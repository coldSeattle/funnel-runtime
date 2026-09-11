import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app';
import { injectTransport } from '../../scripts/traffic/transport';

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

/** Anything Fastify or our hook writes about a single request. */
const requestLines = (lines: LogLine[]) =>
  lines.filter((l) => 'statusCode' in l || l.msg === 'incoming request' || l.msg === 'request completed');

describe('request logging', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('writes exactly one line per normal request: method, url, statusCode, ms', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);

    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(1));
    const [line] = requestLines(lines);
    expect(line).toMatchObject({ level: 30, method: 'GET', url: '/api/health', statusCode: 200 });
    expect(typeof line!.ms).toBe('number');
    expect(line!.ms as number).toBeGreaterThanOrEqual(0);
  });

  it('logs failed requests too, with their status', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    await app.inject({ method: 'GET', url: '/api/sessions/missing' });
    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(1));
    expect(requestLines(lines)[0]).toMatchObject({ method: 'GET', url: '/api/sessions/missing', statusCode: 404 });
  });

  it('writes nothing for a request marked x-synthetic-traffic: 1', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    await app.inject({ method: 'GET', url: '/api/health', headers: { 'x-synthetic-traffic': '1' } });
    // A normal request afterwards proves the hook ran and had the chance to log the first one.
    await app.inject({ method: 'GET', url: '/api/health?after=1' });

    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(1));
    expect(requestLines(lines)[0]).toMatchObject({ url: '/api/health?after=1' });
  });

  it('honours the header from every loopback address form', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      await app.inject({ method: 'GET', url: `/api/health?from=${remoteAddress}`, headers: { 'x-synthetic-traffic': '1' }, remoteAddress });
    }
    await app.inject({ method: 'GET', url: '/api/health?after=1' });

    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(1));
    expect(requestLines(lines)[0]).toMatchObject({ url: '/api/health?after=1' });
  });

  it('logs remote and proxied requests even when they claim to be synthetic', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    await app.inject({ method: 'GET', url: '/api/health?remote=1', headers: { 'x-synthetic-traffic': '1' }, remoteAddress: '203.0.113.7' });
    // A reverse proxy on the same host connects from loopback but says who the visitor is.
    await app.inject({
      method: 'GET',
      url: '/api/health?proxied=1',
      headers: { 'x-synthetic-traffic': '1', 'x-forwarded-for': '203.0.113.7' },
    });

    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(2));
    expect(requestLines(lines).map((l) => l.url)).toEqual(['/api/health?remote=1', '/api/health?proxied=1']);
  });

  it('marks every request of the in-process generator transport as synthetic', async () => {
    const { lines, stream } = captureLogs();
    app = buildApp({ logStream: stream });

    const transport = injectTransport(app);
    expect((await transport.request('GET', '/api/health')).status).toBe(200);
    expect((await transport.request('POST', '/api/sessions', {})).status).toBe(503);
    await app.inject({ method: 'GET', url: '/api/health?after=1' });

    await vi.waitFor(() => expect(requestLines(lines)).toHaveLength(1));
    expect(requestLines(lines)[0]).toMatchObject({ url: '/api/health?after=1' });
  });
});
