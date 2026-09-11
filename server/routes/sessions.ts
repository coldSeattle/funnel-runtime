import type { FastifyPluginCallback } from 'fastify';
import { badRequest } from '../errors';
import type { CreateSessionRequest, ResultResponse, SessionResponse, UpdateStateResponse } from '../../shared/api';

export const sessionRoutes: FastifyPluginCallback = (app, _opts, done) => {
  app.post('/sessions', async (req, reply): Promise<SessionResponse> => {
    const body = req.body;
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw badRequest('The request body must be a JSON object', undefined, 'invalid_body');
    }
    const session = app.ctx.services.sessions.create((body ?? {}) as CreateSessionRequest);
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
