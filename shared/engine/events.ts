import type { FunnelConfig, Step } from '../types';

export type AnswerKind = 'single' | 'multi' | 'number';

/** Event name → allowed event-specific property names, from `events.allowed`. */
export function allowedEvents(config: FunnelConfig): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const def of config.events.allowed) map.set(def.name, new Set(def.properties));
  return map;
}

/** Keeps only whitelisted properties for an event; returns null if the event is not allowed. */
export function filterEventProperties(
  allowed: Map<string, Set<string>>,
  name: string,
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const whitelist = allowed.get(name);
  if (!whitelist) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (whitelist.has(key)) out[key] = value;
  }
  return out;
}

/** The only thing analytics learns about an answer: its kind, never its value. */
export function answerKind(step: Step): AnswerKind | null {
  switch (step.type) {
    case 'single-select':
      return 'single';
    case 'multi-select':
      return 'multi';
    case 'number':
      return 'number';
    default:
      return null;
  }
}
