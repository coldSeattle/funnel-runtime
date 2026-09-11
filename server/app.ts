import Fastify, { type FastifyInstance } from 'fastify';
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
}

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
  const app = Fastify({ logger: opts.logger ?? false });
  const db = openDb(opts.dbPath ?? ':memory:');
  app.decorate('ctx', { db, adminToken: opts.adminToken ?? null, services: createServices(db) });
  app.addHook('onClose', async () => {
    db.close();
  });

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({
      error: {
        code: status === 400 ? 'bad_request' : status >= 500 ? 'internal' : 'error',
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
    if (serveStatic && req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'not_found', message: `Route ${req.method} ${req.url} not found` } });
  });

  return app;
}
