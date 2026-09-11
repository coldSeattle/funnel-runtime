import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingEvent } from '../../shared/api';
import { adoptOrphanQueues, createTracker, type KeyValueStore, type TrackerStorage } from '../../web/tracker/core';
import { allowedEvents } from '../../shared/engine';
import { loadConfig } from '../helpers/configs';

const allowed = allowedEvents(loadConfig('funnel-v1.json'));

function memoryStorage(): TrackerStorage & { value: string | null } {
  return {
    value: null,
    get() {
      return this.value;
    },
    set(next: string) {
      this.value = next;
    },
  };
}

/** A localStorage stand-in: a map of keys, plus a per-key TrackerStorage view like browser.ts builds. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    keys: () => [...data.keys()],
    get: (key) => data.get(key) ?? null,
    remove: (key) => {
      data.delete(key);
    },
  };
  const queue = (key: string): TrackerStorage => ({
    get: () => data.get(key) ?? null,
    set: (value) => {
      data.set(key, value);
    },
    remove: () => {
      data.delete(key);
    },
  });
  return { data, store, queue };
}

function queued(eventId: string, sessionId: string, name = 'cta_clicked'): IncomingEvent {
  return {
    event_id: eventId,
    session_id: sessionId,
    name,
    client_timestamp: '2026-09-08T10:00:00.000Z',
    step_id: 'result',
    properties: { result_id: 'balanced', action: 'expand_recommendation' },
  };
}

/** Deterministic ids and timestamps so assertions can compare whole events. */
function fixtures() {
  let n = 0;
  return {
    uuid: () => `evt-${++n}`,
    now: () => '2026-09-11T00:00:00.000Z',
  };
}

describe('createTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops events that are not in the config whitelist', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, ...fixtures() });

    tracker.track('recommendation_expanded', { properties: { result_id: 'balanced' } });
    tracker.track('totally_unknown');

    expect(tracker.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps only whitelisted properties and never raw answers', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, ...fixtures() });

    tracker.track('answer_submitted', {
      stepId: 'work_mode',
      properties: { answer_kind: 'single', answer: 'hybrid', team_size: 12 },
    });
    await tracker.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual([
      {
        event_id: 'evt-1',
        session_id: 's1',
        name: 'answer_submitted',
        client_timestamp: '2026-09-11T00:00:00.000Z',
        step_id: 'work_mode',
        properties: { answer_kind: 'single' },
      },
    ]);
  });

  it('flushes a batch after the batch delay and persists the queue meanwhile', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const storage = memoryStorage();
    const tracker = createTracker({ sessionId: 's1', allowed, send, storage, batchDelayMs: 800, ...fixtures() });

    tracker.track('step_viewed', { stepId: 'intro', properties: { step_type: 'info' } });
    tracker.track('step_completed', { stepId: 'intro', properties: { next_step_id: 'team_size' } });

    expect(tracker.pending()).toBe(2);
    expect(JSON.parse(storage.value ?? '[]')).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(799);
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].map((e: IncomingEvent) => e.name)).toEqual(['step_viewed', 'step_completed']);
    expect(tracker.pending()).toBe(0);
    expect(JSON.parse(storage.value ?? 'null')).toEqual([]);
  });

  it('sends immediately once batchSize events are queued', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, batchSize: 3, ...fixtures() });

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    expect(send).not.toHaveBeenCalled();

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toHaveLength(3);
  });

  it('keeps failed events with the same event_ids and retries with backoff', async () => {
    const send = vi
      .fn<(events: IncomingEvent[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    const storage = memoryStorage();
    const tracker = createTracker({ sessionId: 's1', allowed, send, storage, ...fixtures() });

    tracker.track('result_viewed', { stepId: 'result', properties: { result_id: 'balanced' } });
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.pending()).toBe(1);

    // First backoff is 1s, so nothing happens earlier.
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(tracker.pending()).toBe(1);

    // Second backoff doubles to 2s.
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);

    const ids = send.mock.calls.map((call) => call[0].map((event) => event.event_id));
    expect(ids).toEqual([['evt-1'], ['evt-1'], ['evt-1']]);
    expect(tracker.pending()).toBe(0);
    expect(JSON.parse(storage.value ?? 'null')).toEqual([]);
  });

  it('keeps the backoff when the batch size is reached while waiting to retry', async () => {
    const send = vi
      .fn<(events: IncomingEvent[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, batchSize: 3, ...fixtures() });

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1); // failed: the next attempt is due 1 s later

    await vi.advanceTimersByTimeAsync(200);
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);

    // The retry stays due at 800 + 1000 ms.
    await vi.advanceTimersByTimeAsync(799);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].map((event) => event.event_id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('still sends a full batch at once when no retry is pending', async () => {
    const send = vi
      .fn<(events: IncomingEvent[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, batchSize: 2, ...fixtures() });

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(800); // fails
    await vi.advanceTimersByTimeAsync(1000); // retry succeeds, backoff is over
    expect(send).toHaveBeenCalledTimes(2);

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('caps the backoff at maxBackoffMs', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => false);
    const tracker = createTracker({ sessionId: 's1', allowed, send, maxBackoffMs: 2000, ...fixtures() });

    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('sends nothing on a second flush after a successful one', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, ...fixtures() });

    tracker.track('cta_clicked', { stepId: 'result', properties: { result_id: 'balanced', action: 'expand_recommendation' } });
    await tracker.flush();
    expect(send).toHaveBeenCalledTimes(1);

    await tracker.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.pending()).toBe(0);
  });

  it('restores a queue left behind by a previous page load', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const storage = memoryStorage();
    storage.value = JSON.stringify([
      { event_id: 'old-1', session_id: 's1', name: 'step_viewed', client_timestamp: '2026-09-10T00:00:00.000Z', properties: {} },
      { nonsense: true },
    ]);
    const tracker = createTracker({ sessionId: 's1', allowed, send, storage, ...fixtures() });

    expect(tracker.pending()).toBe(1);
    await tracker.flush();
    expect(send.mock.calls[0]![0][0]!.event_id).toBe('old-1');
  });

  it('removes its storage key once the queue is drained', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const { data, queue } = memoryStore();
    const tracker = createTracker({ sessionId: 's1', allowed, send, storage: queue('fr.queue.s1'), ...fixtures() });

    tracker.track('step_viewed', { stepId: 'intro', properties: { step_type: 'info' } });
    expect(data.has('fr.queue.s1')).toBe(true);

    await tracker.flush();
    expect(data.has('fr.queue.s1')).toBe(false);
  });

  it('stops queueing after dispose', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const tracker = createTracker({ sessionId: 's1', allowed, send, ...fixtures() });

    tracker.dispose();
    tracker.track('step_viewed', { properties: { step_type: 'info' } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(tracker.pending()).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('adoptOrphanQueues', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers events left in another session queue under their own session_id', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const { data, store, queue } = memoryStore({
      'fr.sessionId': 'new',
      'fr.queue.old': JSON.stringify([queued('orphan-1', 'old')]),
    });
    const tracker = createTracker({ sessionId: 'new', allowed, send, storage: queue('fr.queue.new'), ...fixtures() });

    expect(adoptOrphanQueues({ tracker, store, prefix: 'fr.queue.', ownKey: 'fr.queue.new' })).toBe(1);
    // Moved, not dropped: the orphan key goes only because the live queue now stores the event.
    expect(data.has('fr.queue.old')).toBe(false);
    expect(JSON.parse(data.get('fr.queue.new') ?? '[]')).toEqual([queued('orphan-1', 'old')]);
    expect(data.get('fr.sessionId')).toBe('new');

    // Adoption schedules delivery by itself, no new track() needed.
    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual([queued('orphan-1', 'old')]);
    expect(tracker.pending()).toBe(0);
    expect(data.has('fr.queue.new')).toBe(false);
  });

  it('keeps adopted events queued with the same ids until a send succeeds', async () => {
    const send = vi
      .fn<(events: IncomingEvent[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { data, store, queue } = memoryStore({ 'fr.queue.old': JSON.stringify([queued('orphan-1', 'old')]) });
    const tracker = createTracker({ sessionId: 'new', allowed, send, storage: queue('fr.queue.new'), ...fixtures() });

    adoptOrphanQueues({ tracker, store, prefix: 'fr.queue.', ownKey: 'fr.queue.new' });
    tracker.track('step_viewed', { stepId: 'intro', properties: { step_type: 'info' } });

    await vi.advanceTimersByTimeAsync(800);
    expect(send).toHaveBeenCalledTimes(1);
    // Older adopted events go first; the failed batch stays in storage.
    expect(send.mock.calls[0]![0].map((e) => e.event_id)).toEqual(['orphan-1', 'evt-1']);
    expect(JSON.parse(data.get('fr.queue.new') ?? '[]')).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].map((e) => e.event_id)).toEqual(['orphan-1', 'evt-1']);
    expect(data.has('fr.queue.new')).toBe(false);
  });

  it('leaves the orphan key in place when the live queue cannot be stored', async () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const { data, store } = memoryStore({ 'fr.queue.old': JSON.stringify([queued('orphan-1', 'old')]) });
    const full: TrackerStorage = {
      get: () => null,
      set: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const tracker = createTracker({ sessionId: 'new', allowed, send, storage: full, ...fixtures() });

    adoptOrphanQueues({ tracker, store, prefix: 'fr.queue.', ownKey: 'fr.queue.new' });
    expect(data.has('fr.queue.old')).toBe(true);

    // Still sent from memory; a later start re-adopting it only produces a server-side duplicate.
    await tracker.flush();
    expect(send.mock.calls[0]![0][0]!.event_id).toBe('orphan-1');
  });

  it('skips its own key, merges several orphans without duplicates and clears dead keys', () => {
    const send = vi.fn(async (_events: IncomingEvent[]) => true);
    const { data, store, queue } = memoryStore({
      'fr.queue.new': JSON.stringify([queued('own-1', 'new', 'step_viewed')]),
      'fr.queue.a': JSON.stringify([queued('a-1', 'a'), queued('shared-1', 'a')]),
      'fr.queue.b': JSON.stringify([queued('shared-1', 'a'), queued('b-1', 'b')]),
      'fr.queue.empty': '[]',
      'fr.queue.junk': '{not json',
      'fr.adminToken': 'secret',
    });
    const tracker = createTracker({ sessionId: 'new', allowed, send, storage: queue('fr.queue.new'), ...fixtures() });

    expect(adoptOrphanQueues({ tracker, store, prefix: 'fr.queue.', ownKey: 'fr.queue.new' })).toBe(4);
    expect(tracker.snapshot().map((e) => e.event_id)).toEqual(['a-1', 'shared-1', 'b-1', 'own-1']);
    expect([...data.keys()].sort()).toEqual(['fr.adminToken', 'fr.queue.new']);
  });
});
