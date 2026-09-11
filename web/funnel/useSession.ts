// Session bootstrap (docs/design.md §6): reuse the stored session, fall back to creating one.
// The client keeps only the session id; answers and the current step live on the server.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionResponse, UtmDto } from '../../shared/api';
import type { FunnelConfig } from '../../shared/types';
import { ApiRequestError, createSession, getSession } from '../api';

const SESSION_KEY = 'fr.sessionId';

export type SessionStatus = 'loading' | 'ready' | 'error';

export interface SessionState {
  status: SessionStatus;
  session: SessionResponse['session'] | null;
  config: FunnelConfig | null;
  error: ApiRequestError | null;
  retry: () => void;
  /** Drops the stored id and starts a brand-new session ("Start again"). */
  restart: () => void;
}

export function readStoredSessionId(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeSessionId(id: string): void {
  try {
    window.localStorage.setItem(SESSION_KEY, id);
  } catch {
    // Blocked storage: the session still works for this page load.
  }
}

function clearStoredSessionId(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignored.
  }
}

export function parseQuery(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) query[key] = value;
  return query;
}

function utmFrom(query: Record<string, string>): UtmDto {
  return { source: query.utm_source, medium: query.utm_medium, campaign: query.utm_campaign };
}

async function bootstrap(mode: 'auto' | 'create'): Promise<SessionResponse> {
  const query = parseQuery(window.location.search);
  const storedId = mode === 'create' ? null : readStoredSessionId();

  if (storedId) {
    const existing = await loadStoredSession(storedId);
    if (existing && !wantsOtherVariant(existing, query)) return existing;
  }

  const created = await createSession({
    utm: utmFrom(query),
    query,
    clientTimestamp: new Date().toISOString(),
  });
  storeSessionId(created.session.id);
  return created;
}

/** null means "gone" (404 / 410) — anything else is a real failure and is rethrown. */
async function loadStoredSession(sessionId: string): Promise<SessionResponse | null> {
  try {
    return await getSession(sessionId);
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 410)) {
      clearStoredSessionId();
      return null;
    }
    throw error;
  }
}

/** `?variant=B` on a session that is not B forces a fresh session with that variant. */
function wantsOtherVariant(existing: SessionResponse, query: Record<string, string>): boolean {
  const param = existing.config.experiment.overrideQueryParam;
  if (!param) return false;
  const requested = query[param];
  if (requested === undefined || requested === existing.session.variant) return false;
  // An unknown key would be ignored by the server, so honouring it would recreate the
  // session on every reload; treat it as no override at all.
  return Object.prototype.hasOwnProperty.call(existing.config.experiment.variants, requested);
}

function asApiError(error: unknown): ApiRequestError {
  if (error instanceof ApiRequestError) return error;
  const message = error instanceof Error ? error.message : 'Something went wrong.';
  return new ApiRequestError(0, 'unexpected_error', message);
}

export function useSession(): SessionState {
  const [state, setState] = useState<Omit<SessionState, 'retry' | 'restart'>>({
    status: 'loading',
    session: null,
    config: null,
    error: null,
  });
  const [attempt, setAttempt] = useState<{ n: number; mode: 'auto' | 'create' }>({ n: 0, mode: 'auto' });
  const startedRef = useRef(-1);

  useEffect(() => {
    // Guards the StrictMode double effect: one bootstrap per attempt, never two sessions.
    if (startedRef.current === attempt.n) return;
    startedRef.current = attempt.n;
    setState((prev) => ({ ...prev, status: 'loading', error: null }));
    bootstrap(attempt.mode).then(
      ({ session, config }) => setState({ status: 'ready', session, config, error: null }),
      (error: unknown) => setState({ status: 'error', session: null, config: null, error: asApiError(error) }),
    );
  }, [attempt]);

  const retry = useCallback(() => setAttempt((prev) => ({ n: prev.n + 1, mode: 'auto' })), []);
  const restart = useCallback(() => {
    clearStoredSessionId();
    setAttempt((prev) => ({ n: prev.n + 1, mode: 'create' }));
  }, []);

  return { ...state, retry, restart };
}
