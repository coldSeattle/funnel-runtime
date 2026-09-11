import type { Answers, ResolvedFunnel, Step } from '../types';
import { evaluateCondition } from './conditions';

const INTERACTIVE = new Set(['single-select', 'multi-select', 'number']);

export function isInteractive(step: Step): boolean {
  return INTERACTIVE.has(step.type);
}

/** Key under which a step's answer is stored (input name, falling back to step id). */
export function answerKey(step: Step): string | null {
  if (!isInteractive(step)) return null;
  return step.input?.name ?? step.id;
}

/**
 * Walks the sequence and returns the steps the user can see. A step's `visibleWhen`
 * is evaluated only against answers of steps that were visible before it, so answers
 * of hidden steps never influence later visibility.
 */
export function visibleSteps(resolved: ResolvedFunnel, answers: Answers): Step[] {
  return walk(resolved, answers).steps;
}

/** Answers of visible steps only. Use this for result rules and analytics. */
export function effectiveAnswers(resolved: ResolvedFunnel, answers: Answers): Answers {
  return walk(resolved, answers).answers;
}

function walk(resolved: ResolvedFunnel, answers: Answers): { steps: Step[]; answers: Answers } {
  const steps: Step[] = [];
  const effective: Answers = {};
  for (const step of resolved.steps) {
    if (step.visibleWhen && !evaluateCondition(step.visibleWhen, effective)) continue;
    steps.push(step);
    const key = answerKey(step);
    if (key !== null && answers[key] !== undefined) effective[key] = answers[key]!;
  }
  return { steps, answers: effective };
}

export function firstStepId(resolved: ResolvedFunnel, answers: Answers): string {
  const first = visibleSteps(resolved, answers)[0];
  if (!first) throw new Error('Funnel has no visible steps');
  return first.id;
}

export function nextStepId(resolved: ResolvedFunnel, answers: Answers, currentStepId: string): string | null {
  const steps = visibleSteps(resolved, answers);
  const idx = steps.findIndex((s) => s.id === currentStepId);
  if (idx < 0) return null;
  return steps[idx + 1]?.id ?? null;
}

export function prevStepId(resolved: ResolvedFunnel, answers: Answers, currentStepId: string): string | null {
  const steps = visibleSteps(resolved, answers);
  const idx = steps.findIndex((s) => s.id === currentStepId);
  if (idx <= 0) return null;
  return steps[idx - 1]?.id ?? null;
}

/**
 * Returns a step that is safe to show for a stored `currentStepId`: the step itself if it is
 * visible, otherwise the closest visible step before it in the sequence, otherwise the first step.
 */
export function resolveCurrentStep(resolved: ResolvedFunnel, answers: Answers, currentStepId: string | null): Step {
  const visible = visibleSteps(resolved, answers);
  const first = visible[0];
  if (!first) throw new Error('Funnel has no visible steps');
  if (currentStepId === null) return first;
  const direct = visible.find((s) => s.id === currentStepId);
  if (direct) return direct;
  const seqIdx = resolved.steps.findIndex((s) => s.id === currentStepId);
  if (seqIdx < 0) return first;
  const visibleIds = new Set(visible.map((s) => s.id));
  for (let i = seqIdx - 1; i >= 0; i--) {
    const candidate = resolved.steps[i]!;
    if (visibleIds.has(candidate.id)) return candidate;
  }
  return first;
}
