// Typed client for the endpoints in docs/design.md §5. Base URL is relative: Vite proxies
// /api to the Fastify server in dev, and the server serves the built bundle in production.
import type {
  AnalyticsFilters,
  AnalyticsResponse,
  ApiError,
  CreateSessionRequest,
  HealthResponse,
  HistoryResponse,
  IngestRequest,
  IngestResponse,
  ResultResponse,
  SessionResponse,
  UpdateStateRequest,
  UpdateStateResponse,
  VersionsResponse,
} from '../shared/api';

const BASE_URL = '/api';
const ADMIN_TOKEN_KEY = 'fr.adminToken';

/** Thrown for every non-2xx response and for transport failures (status 0). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export function getAdminToken(): string | null {
  try {
    return window.localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token === null || token === '') window.localStorage.removeItem(ADMIN_TOKEN_KEY);
    else window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
  } catch {
    // Private mode or blocked storage: the token stays in memory for this page only.
  }
}

type QueryValue = string | number | boolean | undefined | null;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Attach x-admin-token from localStorage when present. */
  admin?: boolean;
}

function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.admin) {
    const token = getAdminToken();
    if (token) headers['x-admin-token'] = token;
  }

  let response: Response;
  try {
    response = await fetch(BASE_URL + path + buildQuery(options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiRequestError(0, 'network_error', 'Network request failed. Check your connection and try again.');
  }

  const text = await response.text();
  const payload = text ? parseJson(text) : undefined;

  if (!response.ok) {
    const error = (payload as ApiError | undefined)?.error;
    throw new ApiRequestError(
      response.status,
      error?.code ?? `http_${response.status}`,
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details,
    );
  }

  return payload as T;
}

export function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function createSession(body: CreateSessionRequest): Promise<SessionResponse> {
  return request<SessionResponse>('/sessions', { method: 'POST', body });
}

export function getSession(sessionId: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export function updateSessionState(sessionId: string, body: UpdateStateRequest): Promise<UpdateStateResponse> {
  return request<UpdateStateResponse>(`/sessions/${encodeURIComponent(sessionId)}/state`, { method: 'PUT', body });
}

export function computeSessionResult(sessionId: string): Promise<ResultResponse> {
  return request<ResultResponse>(`/sessions/${encodeURIComponent(sessionId)}/result`, { method: 'POST' });
}

export function ingestEvents(body: IngestRequest): Promise<IngestResponse> {
  return request<IngestResponse>('/events', { method: 'POST', body });
}

export function getVersions(): Promise<VersionsResponse> {
  return request<VersionsResponse>('/admin/versions', { admin: true });
}

/** The design doc only pins `{ version }` for 201; every field is optional so any superset fits. */
export interface VersionMutationResponse {
  version?: number;
  activeVersion?: number | null;
}

export function createVersion(config: unknown): Promise<VersionMutationResponse> {
  return request<VersionMutationResponse>('/admin/versions', { method: 'POST', body: config, admin: true });
}

export function publishVersion(version: number): Promise<VersionMutationResponse> {
  return request<VersionMutationResponse>(`/admin/versions/${version}/publish`, { method: 'POST', admin: true });
}

export function rollback(): Promise<VersionMutationResponse> {
  return request<VersionMutationResponse>('/admin/rollback', { method: 'POST', admin: true });
}

export function getHistory(): Promise<HistoryResponse> {
  return request<HistoryResponse>('/admin/history', { admin: true });
}

export function getAnalytics(filters: AnalyticsFilters): Promise<AnalyticsResponse> {
  return request<AnalyticsResponse>('/analytics', {
    query: {
      version: filters.version,
      variant: filters.variant,
      utm_campaign: filters.utmCampaign,
      excludeOverrides: filters.excludeOverrides ? 1 : undefined,
    },
  });
}
