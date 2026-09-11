// Browser / Android back inside the funnel (DOM-free decisions; the wiring is in FunnelPage).
//
// Every step shown after a forward move gets its own history entry, stamped with the session and
// a depth (0 = the entry the funnel booted on). The URL never changes, so a shared link can never
// jump into the middle of a funnel. The UI knows which depth its current step belongs to; a
// popstate compares the entry's depth with it:
//   lower  → one step back, exactly like the in-app Back (PUT, then back_clicked);
//   higher → forward: never skips validation, the browser is sent back to the UI's entry;
//   equal  → our own realignment, nothing to do.

export interface FunnelEntry {
  sessionId: string;
  stepId: string;
  depth: number;
}

/** Key inside history.state; the rest of the state (react-router's usr/key/idx) is kept as is. */
const STATE_KEY = 'funnelStep';

export function readEntry(state: unknown): FunnelEntry | null {
  if (typeof state !== 'object' || state === null) return null;
  const entry = (state as Record<string, unknown>)[STATE_KEY];
  if (typeof entry !== 'object' || entry === null) return null;
  const { sessionId, stepId, depth } = entry as Record<string, unknown>;
  if (typeof sessionId !== 'string' || typeof stepId !== 'string') return null;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) return null;
  return { sessionId, stepId, depth };
}

export function stampState(state: unknown, entry: FunnelEntry): Record<string, unknown> {
  const base = typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : {};
  return { ...base, [STATE_KEY]: entry };
}

/** A reload keeps the tab's entries, so the same session resumes at the depth it had. */
export function initialDepth(state: unknown, sessionId: string): number {
  const entry = readEntry(state);
  return entry !== null && entry.sessionId === sessionId ? entry.depth : 0;
}

export interface PopContext {
  sessionId: string;
  /** Depth of the entry the step on screen belongs to. */
  uiDepth: number;
  /** A PUT is in flight. */
  busy: boolean;
  /** The step on screen has a previous visible step. */
  canGoBack: boolean;
}

export type PopDecision =
  /** Not a funnel entry (another route handles it) or the browser is already where the UI is. */
  | { kind: 'ignore' }
  /** An entry left by an earlier session in this tab (after "Start again"): step over it. */
  | { kind: 'skip' }
  /** Run the in-app back navigation. */
  | { kind: 'back' }
  /** On the first step there is nothing to go back to: accept the move, the next back leaves. */
  | { kind: 'accept' }
  /** Forward, or back pressed during a save: send the browser back to the UI's entry. */
  | { kind: 'realign'; delta: number };

export function decidePop(entry: FunnelEntry | null, context: PopContext): PopDecision {
  if (entry === null) return { kind: 'ignore' };
  if (entry.sessionId !== context.sessionId) return { kind: 'skip' };
  if (entry.depth === context.uiDepth) return { kind: 'ignore' };
  if (entry.depth > context.uiDepth || context.busy) {
    return { kind: 'realign', delta: context.uiDepth - entry.depth };
  }
  return context.canGoBack ? { kind: 'back' } : { kind: 'accept' };
}
