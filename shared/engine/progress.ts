import type { Answers, FunnelConfig, ResolvedFunnel } from '../types';
import { visibleSteps } from './visibility';

export interface Progress {
  /** 1-based position of the current step among countable steps */
  index: number;
  count: number;
}

/**
 * Progress over the steps the user can actually see, excluding types listed in
 * `progress.excludeTypes` (info / result). Returns null for excluded steps.
 */
export function progress(
  resolved: ResolvedFunnel,
  answers: Answers,
  currentStepId: string,
  settings: FunnelConfig['progress'] = resolved.config.progress,
): Progress | null {
  const steps = settings.countVisibleOnly ? visibleSteps(resolved, answers) : resolved.steps;
  const countable = steps.filter((s) => !settings.excludeTypes.includes(s.type));
  const idx = countable.findIndex((s) => s.id === currentStepId);
  if (idx < 0) return null;
  return { index: idx + 1, count: countable.length };
}
