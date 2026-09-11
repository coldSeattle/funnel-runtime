import type { FastifyInstance } from 'fastify';

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface TransportResponse<T> {
  status: number;
  body: T;
}

/** How the generator talks to the API: in-process (`inject`) or over HTTP to a deployed host. */
export interface Transport {
  request<T>(method: HttpMethod, path: string, body?: unknown): Promise<TransportResponse<T>>;
}

export interface TransportOptions {
  /** Sent as `x-admin-token`, and only on /api/admin/* requests, so it never travels further than needed. */
  adminToken?: string | null;
}

function adminHeaders(path: string, opts: TransportOptions): Record<string, string> {
  const isAdmin = path === '/api/admin' || path.startsWith('/api/admin/') || path.startsWith('/api/admin?');
  return opts.adminToken && isAdmin ? { 'x-admin-token': opts.adminToken } : {};
}

/** Every in-process request is synthetic traffic; the server leaves those out of its request log. */
export function injectTransport(app: FastifyInstance, opts: TransportOptions = {}): Transport {
  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown) {
      const res = await app.inject({
        method,
        url: path,
        headers: { 'x-synthetic-traffic': '1', ...adminHeaders(path, opts) },
        ...(body === undefined ? {} : { payload: body as object }),
      });
      return { status: res.statusCode, body: parseBody(res.body) as T };
    },
  };
}

// Render's free tier can take close to a minute to wake up.
const HTTP_TIMEOUT_MS = 90_000;

export function httpTransport(baseUrl: string, opts: TransportOptions = {}): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async request<T>(method: HttpMethod, path: string, body?: unknown) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...adminHeaders(path, opts) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return { status: res.status, body: parseBody(await res.text()) as T };
    },
  };
}

function parseBody(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
