import type { FastifyPluginCallback } from 'fastify';
import { badRequest } from '../errors';
import { MAX_BATCH_SIZE } from '../services/ingest';
import type { IngestResponse } from '../../shared/api';

/**
 * The batch itself is the only thing that can fail with a 4xx: every single event is
 * reported per item so one bad event never costs the client the rest of the flush.
 */
export const eventRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/events', async (req): Promise<IngestResponse> => {
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw badRequest('The request body must be { events: [...] }', undefined, 'invalid_body');
    }
    const events = (body as { events?: unknown }).events;
    if (!Array.isArray(events)) {
      throw badRequest('`events` must be an array', undefined, 'invalid_body');
    }
    if (events.length > MAX_BATCH_SIZE) {
      throw badRequest(`A batch may contain at most ${MAX_BATCH_SIZE} events`, { max: MAX_BATCH_SIZE }, 'batch_too_large');
    }
    return app.ctx.services.ingest.ingestBatch(events);
  });

  done();
};
