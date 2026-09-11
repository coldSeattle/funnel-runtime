import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingEvent } from '../../shared/api';
import { createTracker, type TrackerStorage } from '../../web/tracker/core';
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
