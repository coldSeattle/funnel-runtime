// Event queue with whitelist filtering, batching, persistence and retry (docs/design.md §7).
// DOM-free on purpose: everything environment-specific is injected, so this file is unit-testable
// under the server tsconfig and the browser wiring lives in ./browser.ts.
import type { IncomingEvent } from '../../shared/api';
import { filterEventProperties } from '../../shared/engine';

export interface TrackerStorage {
  get(): string | null;
  /** May throw (quota, blocked storage); the tracker then keeps the queue in memory only. */
  set(value: string): void;
  /** Drops the key once the queue is empty, so drained queues do not pile up in storage. */
  remove?(): void;
}

/** The slice of localStorage that orphan-queue adoption needs; injected to stay testable. */
export interface KeyValueStore {
  keys(): string[];
  get(key: string): string | null;
  remove(key: string): void;
}

export interface TrackOptions {
  stepId?: string | null;
  properties?: Record<string, unknown>;
}

export interface Tracker {
  /** Drops unknown event names and non-whitelisted properties; never throws. */
  track(name: string, options?: TrackOptions): void;
  /**
   * Takes over already-built events from another queue (they keep their own session_id and
   * event_id). Returns true only when the merged queue was written to storage.
   */
  adopt(events: IncomingEvent[]): boolean;
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

  let queue: IncomingEvent[] = parseQueue(safeRead(() => storage?.get() ?? null));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let disposed = false;

  function persist(): boolean {
    if (!storage) return false;
    try {
      if (queue.length === 0 && storage.remove) storage.remove();
      else storage.set(JSON.stringify(queue));
      return true;
    } catch {
      // Storage full or blocked: the queue still lives in memory for this page.
      return false;
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
      // A full batch only skips the normal batch delay. While a failed send is backing off, the
      // pending retry timer stays in charge, otherwise a busy page would hammer a failing server.
      if (queue.length >= batchSize && failures === 0) {
        clearTimer();
        void flush();
      } else {
        schedule(batchDelayMs);
      }
    },
    adopt(events: IncomingEvent[]): boolean {
      if (disposed) return false;
      const known = new Set(queue.map((event) => event.event_id));
      const fresh: IncomingEvent[] = [];
      for (const event of events) {
        if (!isIncomingEvent(event) || known.has(event.event_id)) continue;
        known.add(event.event_id);
        fresh.push(event);
      }
      // Adopted events are older than anything this session queued, so they go first.
      queue = [...fresh, ...queue];
      const stored = persist();
      if (queue.length > 0) schedule(batchDelayMs);
      return stored;
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

export interface AdoptOrphanQueuesOptions {
  tracker: Tracker;
  store: KeyValueStore;
  /** Every tracker persists under `prefix + sessionId`. */
  prefix: string;
  /** The live tracker's own key; it is restored by the tracker itself. */
  ownKey: string;
}

/**
 * A new session (restart, 404/410, `?variant` override) gets a new queue key, and nothing else
 * would ever read the previous one — its unsent events, possibly `cta_clicked`, would be lost.
 * The live tracker takes them over instead: every event keeps its own session_id, so attribution
 * is unchanged, and the server accepts late events for expired sessions (docs/design.md §14).
 * A source key is removed only after the live queue has stored its events, and from then on they
 * leave storage only after a 2xx, like any other event. Returns the number of events found.
 */
export function adoptOrphanQueues({ tracker, store, prefix, ownKey }: AdoptOrphanQueuesOptions): number {
  const keys = safeRead(() => store.keys()) ?? [];
  const empty: string[] = [];
  const sources: string[] = [];
  const events: IncomingEvent[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix) || key === ownKey) continue;
    const queued = parseQueue(safeRead(() => store.get(key)));
    if (queued.length === 0) {
      empty.push(key); // drained, unparseable or already gone: nothing left to deliver
    } else {
      sources.push(key);
      events.push(...queued);
    }
  }

  const removable = events.length > 0 && tracker.adopt(events) ? [...empty, ...sources] : empty;
  for (const key of removable) {
    try {
      store.remove(key);
    } catch {
      // Left for the next start; re-adopting it only yields server-side duplicates.
    }
  }
  return events.length;
}

function safeRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function parseQueue(raw: string | null): IncomingEvent[] {
  if (!raw) return [];
  try {
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
