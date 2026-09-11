import type { FastifyPluginCallback } from 'fastify';
import { badRequest } from '../errors';
import type { AnalyticsFilters, AnalyticsResponse } from '../../shared/api';

type Query = Record<string, string | string[] | undefined>;

/** Empty values mean "no filter" so the dashboard can send every select as-is. */
function param(query: Query, key: string): string | undefined {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const analyticsRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.get<{ Querystring: Query }>('/analytics', async (req): Promise<AnalyticsResponse> => {
    const filters: AnalyticsFilters = {};

    const version = param(req.query, 'version');
    if (version !== undefined) {
      // Number() alone would also take "0x1", "1e0" and "+1"; a version is plain decimal digits.
      const parsed = /^\d+$/.test(version) ? Number(version) : NaN;
      if (!Number.isSafeInteger(parsed)) throw badRequest(`"${version}" is not a version number`, { version }, 'invalid_filter');
      filters.version = parsed;
    }
    const variant = param(req.query, 'variant');
    if (variant !== undefined) filters.variant = variant;
    const campaign = param(req.query, 'utm_campaign');
    if (campaign !== undefined) filters.utmCampaign = campaign;
    const exclude = param(req.query, 'excludeOverrides');
    if (exclude === '1' || exclude === 'true') filters.excludeOverrides = true;

    return app.ctx.services.analytics.analytics(filters);
  });

  done();
};
