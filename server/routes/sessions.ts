import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../errors';
import type { CreateSessionRequest, ResultResponse, SessionResponse, UpdateStateResponse } from '../../shared/api';

const utmValue = z.string().nullish();

// Mirrors CreateSessionRequest: every value ends up in a TEXT column or an object-key lookup, so a
// non-string must be rejected here rather than reach SQLite (500) or be coerced ("42" vs "42.0").
const createSessionBodySchema = z.object({
  utm: z.object({ source: utmValue, medium: utmValue, campaign: utmValue }).optional(),
  query: z.record(z.string(), z.string()).optional(),
  variantOverride: z.string().optional(),
  clientTimestamp: z.string().optional(),
}) satisfies z.ZodType<CreateSessionRequest>;

export const sessionRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/sessions', async (req, reply): Promise<SessionResponse> => {
    const parsed = createSessionBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('The request body is not a valid session request', parsed.error.issues, 'invalid_body');
    }
    const session = app.ctx.services.sessions.create(parsed.data);
    return reply.status(201).send(session);
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req): Promise<SessionResponse> =>
    app.ctx.services.sessions.get(req.params.id),
  );

  app.put<{ Params: { id: string } }>('/sessions/:id/state', async (req): Promise<UpdateStateResponse> =>
    app.ctx.services.sessions.updateState(req.params.id, req.body),
  );

  app.post<{ Params: { id: string } }>('/sessions/:id/result', async (req): Promise<ResultResponse> =>
    app.ctx.services.sessions.computeResult(req.params.id),
  );

  done();
};
