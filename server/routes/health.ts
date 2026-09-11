import type { FastifyPluginCallback } from 'fastify';
import type { HealthResponse } from '../../shared/api';

export const healthRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get('/health', async (): Promise<HealthResponse> => {
    const row = app.ctx.db.prepare('SELECT active_version FROM funnels LIMIT 1').get() as
      | { active_version: number | null }
      | undefined;
    return { ok: true, activeVersion: row?.active_version ?? null };
  });
  done();
};
