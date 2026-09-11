// Browser wiring for the tracker core: fetch transport, localStorage queue, beacon on page hide.
import type { IncomingEvent, IngestRequest } from '../../shared/api';
import { createTracker, type Tracker, type TrackerStorage } from './core';

const EVENTS_URL = '/api/events';
const QUEUE_KEY_PREFIX = 'fr.queue.';

export interface BrowserTracker extends Tracker {
  /** Registers pagehide/visibility listeners and returns the remover (safe to call repeatedly). */
  attach(): () => void;
}

export interface BrowserTrackerOptions {
  sessionId: string;
  allowed: Map<string, Set<string>>;
}

export function createBrowserTracker({ sessionId, allowed }: BrowserTrackerOptions): BrowserTracker {
  const tracker = createTracker({
    sessionId,
    allowed,
    send: postEvents,
    storage: localStorageQueue(QUEUE_KEY_PREFIX + sessionId),
    uuid: browserUuid,
  });

  // The queue is deliberately not cleared here: sendBeacon gives no response, and the server
  // de-duplicates by event_id, so a beacon that did arrive costs at most one duplicate.
  function beacon(): void {
    const pending = tracker.snapshot();
    if (pending.length === 0) return;
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
    try {
      const body: IngestRequest = { events: pending };
      navigator.sendBeacon(EVENTS_URL, new Blob([JSON.stringify(body)], { type: 'application/json' }));
    } catch {
      // Beacon rejected (payload too large, page discarded): the queue survives in localStorage.
    }
  }

  function onPageHide(): void {
    beacon();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'hidden') beacon();
  }

  return {
    ...tracker,
    attach(): () => void {
      window.addEventListener('pagehide', onPageHide);
      document.addEventListener('visibilitychange', onVisibilityChange);
      return () => {
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      };
    },
  };
}

async function postEvents(events: IncomingEvent[]): Promise<boolean> {
  const body: IngestRequest = { events };
  try {
    const response = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function localStorageQueue(key: string): TrackerStorage {
  return {
    get() {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(value: string) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ignored: the in-memory queue keeps working without persistence.
      }
    },
  };
}

function browserUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Falls through to the core's Math.random id.
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`;
}
