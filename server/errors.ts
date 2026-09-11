/** Error with an HTTP status and a stable machine-readable code. Serialised as { error: { code, message, details } }. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (message: string, code = 'not_found') => new HttpError(404, code, message);
export const badRequest = (message: string, details?: unknown, code = 'bad_request') => new HttpError(400, code, message, details);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
