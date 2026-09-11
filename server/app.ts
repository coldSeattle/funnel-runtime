import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from './db';
import { HttpError } from './errors';
import { createServices, type Services } from './services';
import { adminRoutes } from './routes/admin';
import { analyticsRoutes } from './routes/analytics';
import { eventRoutes } from './routes/events';
import { healthRoutes } from './routes/health';
import { sessionRoutes } from './routes/sessions';

export interface AppOptions {
  /** SQLite file path; ':memory:' (default) for tests */
  dbPath?: string;
  /** When set, /api/admin/* requires header x-admin-token */
  adminToken?: string | null;
  /** Directory with the built web app; served with SPA fallback when it exists */
  staticDir?: string | null;
  logger?: boolean;
  /** Log destination at info level (tests capture lines with it); implies logging */
  logStream?: { write(line: string): void };
}

/** Set by the in-process traffic generator; such requests are not logged one by one. */
const SYNTHETIC_TRAFFIC_HEADER = 'x-synthetic-traffic';

export interface AppContext {
  db: Db;
  adminToken: string | null;
  services: Services;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logStream ? { level: 'info', stream: opts.logStream } : (opts.logger ?? false),
    // Fastify's own incoming/completed pair is replaced by the single onResponse line below.
    // (The top-level `disableRequestLogging` option is deprecated in Fastify 5.12.)
    logController: new LogController({ disableRequestLogging: true }),
  });
  // SEED_ON_BOOT pushes ~4,000 generator requests through inject; one line each would bury the log.
  app.addHook('onResponse', async (req, reply) => {
    if (req.headers[SYNTHETIC_TRAFFIC_HEADER] === '1') return;
    req.log.info({ method: req.method, url: req.url, statusCode: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
  });
  const db = openDb(opts.dbPath ?? ':memory:');
  app.decorate('ctx', { db, adminToken: opts.adminToken ?? null, services: createServices(db) });
  app.addHook('onClose', async () => {
    db.close();
  });

  // Fetch wrappers commonly send `content-type: application/json` with no body on bodiless POSTs
  // (publish, rollback, result); Fastify rejects that with a 400 by default. Treat an empty body as
  // "no body" and keep the default parser, with its prototype-poisoning guard, for everything else.
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    defaultJsonParser(req, text, done);
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: unknown; message?: unknown; code?: unknown };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) {
      // Unexpected 5xx messages come from drivers and internals; log them, never echo them to the client.
      app.log.error(err);
      return reply.status(status).send({ error: { code: 'internal', message: 'Internal error' } });
    }
    if (isBodyParseFailure(err, status)) {
      return reply.status(400).send({ error: { code: 'invalid_body', message: 'The request body is not valid JSON' } });
    }
    return reply.status(status).send({
      error: {
        code: status === 400 ? 'bad_request' : 'error',
        message: typeof e.message === 'string' ? e.message : 'Unexpected error',
      },
    });
  });

  app.register(healthRoutes, { prefix: '/api' });
  app.register(sessionRoutes, { prefix: '/api' });
  app.register(eventRoutes, { prefix: '/api' });
  app.register(analyticsRoutes, { prefix: '/api' });
  app.register(adminRoutes, { prefix: '/api/admin' });

  const staticDir = opts.staticDir ?? null;
  const serveStatic = staticDir !== null && existsSync(join(staticDir, 'index.html'));
  if (serveStatic) {
    app.register(fastifyStatic, { root: staticDir, wildcard: false, index: false });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0]!;
    const isApi = path === '/api' || path.startsWith('/api/');
    if (serveStatic && req.method === 'GET' && !isApi) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } });
  });

  return app;
}

/**
 * Fastify reports unreadable bodies as FST_ERR_CTP_* 400s (broken JSON, prototype poisoning,
 * a bad content-length); a stream error surfaces as a SyntaxError with statusCode 400.
 */
function isBodyParseFailure(err: unknown, status: number): boolean {
  if (status !== 400) return false;
  const code = (err as { code?: unknown }).code;
  return (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) || err instanceof SyntaxError;
}
