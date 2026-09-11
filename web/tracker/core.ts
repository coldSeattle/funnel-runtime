// Event queue with whitelist filtering, batching, persistence and retry (docs/design.md §7).
// DOM-free on purpose: everything environment-specific is injected, so this file is unit-testable
// under the server tsconfig and the browser wiring lives in ./browser.ts.
import type { IncomingEvent } from '../../shared/api';
import { filterEventProperties } from '../../shared/engine';

export interface TrackerStorage {
  get(): string | null;
  set(value: string): void;
}

export interface TrackOptions {
  stepId?: string | null;
  properties?: Record<string, unknown>;
}

export interface Tracker {
  /** Drops unknown event names and non-whitelisted properties; never throws. */
  track(name: string, options?: TrackOptions): void;
  flush(): Promise<void>;
  pending(): number;
  /** Queued events, without removing them — used by the sendBeacon path on pagehide. */
  snapshot(): IncomingEvent[];
  dispose(): void;
}

export interface TrackerOptions {
  sessionId: string;
  /** Event name → allowed property names, from `allowedEvents(config)`. */
  allowed: Map<string, Set<string>>;
  /** Resolves true when the batch is durably accepted; false (or throws) to keep and retry it. */
  send: (events: IncomingEvent[]) => Promise<boolean>;
  storage?: TrackerStorage;
  now?: () => string;
  uuid?: () => string;
  batchDelayMs?: number;
  batchSize?: number;
  maxBackoffMs?: number;
}

const FIRST_BACKOFF_MS = 1000;

export function createTracker(options: TrackerOptions): Tracker {
  const {
    sessionId,
    allowed,
    send,
    storage,
    now = () => new Date().toISOString(),
    uuid = randomId,
    batchDelayMs = 800,
    batchSize = 10,
    maxBackoffMs = 30_000,
  } = options;

  let queue: IncomingEvent[] = restore(storage);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let disposed = false;

  function persist(): void {
    if (!storage) return;
    try {
      storage.set(JSON.stringify(queue));
    } catch {
      // Storage full or blocked: the queue still lives in memory for this page.
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delayMs: number): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  }

  async function deliver(batch: IncomingEvent[]): Promise<void> {
    let ok = false;
    try {
      ok = await send(batch);
    } catch {
      ok = false;
    }

    if (ok) {
      const sent = new Set(batch.map((event) => event.event_id));
      queue = queue.filter((event) => !sent.has(event.event_id));
      persist();
      failures = 0;
      if (queue.length > 0) schedule(batchDelayMs);
      return;
    }

    // Keep the events with their original ids: a retried batch is de-duplicated server-side.
    failures += 1;
    schedule(Math.min(maxBackoffMs, FIRST_BACKOFF_MS * 2 ** (failures - 1)));
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (queue.length === 0) return Promise.resolve();
    clearTimer();
    const batch = queue.slice(0, batchSize);
    const run = deliver(batch)
      .catch(() => undefined)
      .then(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  }

  return {
    track(name: string, trackOptions: TrackOptions = {}): void {
      if (disposed) return;
      const properties = filterEventProperties(allowed, name, trackOptions.properties);
      if (properties === null) return; // not in this config version's whitelist
      queue.push({
        event_id: uuid(),
        session_id: sessionId,
        name,
        client_timestamp: now(),
        step_id: trackOptions.stepId ?? null,
        properties,
      });
      persist();
      if (queue.length >= batchSize) {
        clearTimer();
        void flush();
      } else {
        schedule(batchDelayMs);
      }
    },
    flush,
    pending: () => queue.length,
    snapshot: () => queue.slice(),
    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}

function restore(storage: TrackerStorage | undefined): IncomingEvent[] {
  if (!storage) return [];
  try {
    const raw = storage.get();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isIncomingEvent);
  } catch {
    return [];
  }
}

function isIncomingEvent(value: unknown): value is IncomingEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.event_id === 'string' &&
    typeof event.session_id === 'string' &&
    typeof event.name === 'string' &&
    typeof event.client_timestamp === 'string'
  );
}

const HEX = '0123456789abcdef';

/** UUID-v4-shaped fallback; browsers inject crypto.randomUUID instead. */
function randomId(): string {
  let out = '';
  for (let i = 0; i < 32; i++) {
    if (i === 12) out += '4';
    else if (i === 16) out += HEX.charAt(8 + Math.floor(Math.random() * 4));
    else out += HEX.charAt(Math.floor(Math.random() * 16));
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}
