import { describe, expect, it } from 'vitest';
import { decidePop, initialDepth, readEntry, stampState, type PopContext } from '../../web/funnel/stepHistory';

const context: PopContext = { sessionId: 's1', uiDepth: 2, busy: false, canGoBack: true };
const entry = (depth: number, sessionId = 's1') => ({ sessionId, stepId: `step-${depth}`, depth });

describe('stampState / readEntry', () => {
  it('keeps the router state and round-trips the funnel entry', () => {
    const routerState = { usr: null, key: 'abc', idx: 3 };
    const stamped = stampState(routerState, entry(1));
    expect(stamped).toMatchObject(routerState);
    expect(readEntry(stamped)).toEqual(entry(1));
  });

  it('reads nothing from foreign or malformed state', () => {
    expect(readEntry(null)).toBeNull();
    expect(readEntry({ usr: null, key: 'abc', idx: 0 })).toBeNull();
    expect(readEntry({ funnelStep: { sessionId: 's1', stepId: 'x', depth: -1 } })).toBeNull();
    expect(readEntry({ funnelStep: { sessionId: 's1', stepId: 'x', depth: 1.5 } })).toBeNull();
    expect(readEntry({ funnelStep: 'nope' })).toBeNull();
  });
});

describe('initialDepth', () => {
  it('resumes the depth of the same session after a reload', () => {
    expect(initialDepth(stampState(null, entry(4)), 's1')).toBe(4);
  });

  it('starts at 0 for a fresh entry or another session', () => {
    expect(initialDepth(null, 's1')).toBe(0);
    expect(initialDepth(stampState(null, entry(4, 'old')), 's1')).toBe(0);
  });
});

describe('decidePop', () => {
  it('goes one step back when the browser moves to a shallower entry', () => {
    expect(decidePop(entry(1), context)).toEqual({ kind: 'back' });
  });

  it('never moves forward: forward is sent back to the step on screen', () => {
    expect(decidePop(entry(3), context)).toEqual({ kind: 'realign', delta: -1 });
    expect(decidePop(entry(5), context)).toEqual({ kind: 'realign', delta: -3 });
  });

  it('drops a back press during a save by returning to the current entry', () => {
    expect(decidePop(entry(1), { ...context, busy: true })).toEqual({ kind: 'realign', delta: 1 });
  });

  it('ignores the pop that its own realignment causes', () => {
    expect(decidePop(entry(2), context)).toEqual({ kind: 'ignore' });
  });

  it('ignores entries that are not funnel entries', () => {
    expect(decidePop(null, context)).toEqual({ kind: 'ignore' });
  });

  it('steps over entries of an earlier session in the same tab', () => {
    expect(decidePop(entry(1, 'old'), context)).toEqual({ kind: 'skip' });
  });

  it('accepts the move when the step on screen has no previous step', () => {
    expect(decidePop(entry(1), { ...context, canGoBack: false })).toEqual({ kind: 'accept' });
  });
});
