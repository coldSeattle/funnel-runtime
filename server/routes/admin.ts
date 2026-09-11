import type { FastifyPluginCallback } from 'fastify';
import { HttpError, badRequest } from '../errors';
import type { HistoryResponse, VersionsResponse } from '../../shared/api';

/** Routes are registered under /api/admin; auth is a no-op unless ADMIN_TOKEN is configured. */
export const adminRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.addHook('onRequest', async (req) => {
    const expected = app.ctx.adminToken;
    if (!expected) return;
    if (req.headers['x-admin-token'] !== expected) {
      throw new HttpError(401, 'unauthorized', 'A valid x-admin-token header is required');
    }
  });

  app.get('/versions', async (): Promise<VersionsResponse> => app.ctx.services.versions.list());

  app.post('/versions', async (req, reply): Promise<{ version: number }> => {
    const { version } = app.ctx.services.versions.upload(req.body);
    return reply.status(201).send({ version });
  });

  app.post<{ Params: { version: string } }>('/versions/:version/publish', async (req) => {
    const version = Number(req.params.version);
    if (!Number.isInteger(version)) throw badRequest(`"${req.params.version}" is not a version number`, undefined, 'invalid_version');
    return app.ctx.services.versions.publish(version);
  });

  app.post('/rollback', async () => app.ctx.services.versions.rollback());

  app.get('/history', async (): Promise<HistoryResponse> => app.ctx.services.versions.history());

  done();
};
