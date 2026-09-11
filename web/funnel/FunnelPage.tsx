// The funnel screen. Nothing is hard-coded: steps, copy, validation and the event whitelist
// all come from the session's config version, rendered through the shared engine.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionDto } from '../../shared/api';
import type { Answers, FunnelConfig, ResolvedFunnel, Step } from '../../shared/types';
import {
  allowedEvents,
  answerKey,
  answerKind,
  isInteractive,
  nextStepId,
  prevStepId,
  progress,
  resolveCurrentStep,
  resolveVariant,
  validateAnswer,
  visibleSteps,
} from '../../shared/engine';
import { ApiRequestError, updateSessionState } from '../api';
import { createBrowserTracker } from '../tracker/browser';
import { ProgressBar } from './ProgressBar';
import { InfoStep } from './steps/InfoStep';
import { MultiSelectStep } from './steps/MultiSelectStep';
import { NumberStep } from './steps/NumberStep';
import { ResultStep } from './steps/ResultStep';
import { SingleSelectStep } from './steps/SingleSelectStep';
import { useSession } from './useSession';

const ERROR_ID = 'step-error';

export function FunnelPage() {
  const { status, session, config, error, retry, restart } = useSession();

  useEffect(() => {
    if (config) document.title = config.title;
  }, [config]);

  const resolved = useMemo(() => {
    if (!config || !session) return null;
    try {
      return resolveVariant(config, session.variant);
    } catch {
      return null;
    }
  }, [config, session]);

  if (status === 'loading') return <BootScreen />;

  if (status === 'error' || !session || !config) {
    return (
      <BootError
        title="We could not start the questionnaire"
        message={error?.message ?? 'Please try again.'}
        onRetry={retry}
      />
    );
  }

  if (!resolved) {
    return (
      <BootError
        title="This session cannot be displayed"
        message={`Variant "${session.variant}" is not part of config version ${config.version}.`}
        onRetry={restart}
        retryLabel="Start again"
      />
    );
  }

  return <FunnelRunner key={session.id} session={session} config={config} resolved={resolved} onRestart={restart} />;
}

function BootScreen() {
  return (
    <div className="funnel">
      <div className="funnel-shell">
        <div className="card card-centered" aria-busy="true">
          <div className="result-spinner" aria-hidden="true" />
          <p className="step-helper">Loading your questionnaire…</p>
        </div>
      </div>
    </div>
  );
}

function BootError({
  title,
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  title: string;
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="funnel">
      <div className="funnel-shell">
        <div className="card card-centered">
          <h1 className="step-title">{title}</h1>
          <p className="step-helper">{message}</p>
          <button type="button" className="button button-primary" onClick={onRetry}>
            {retryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

type DraftValue = string | string[];

interface StepDraft {
  stepId: string;
  value: DraftValue;
  fieldError: string | null;
  failure: { message: string; action: 'submit' | 'back' } | null;
}

interface FunnelRunnerProps {
  session: SessionDto;
  config: FunnelConfig;
  resolved: ResolvedFunnel;
  onRestart: () => void;
}

function FunnelRunner({ session, config, resolved, onRestart }: FunnelRunnerProps) {
  const [answers, setAnswers] = useState<Answers>(session.answers);
  const [stepId, setStepId] = useState(() => resolveCurrentStep(resolved, session.answers, session.currentStepId).id);
  const [busy, setBusy] = useState(false);

  const step = useMemo(() => resolveCurrentStep(resolved, answers, stepId), [resolved, answers, stepId]);

  // Draft is re-derived whenever the step changes; no effect, so there is no empty first frame.
  const [draftState, setDraftState] = useState<StepDraft>(() => freshDraft(step, answers));
  const draft = draftState.stepId === step.id ? draftState : freshDraft(step, answers);

  const allowed = useMemo(() => allowedEvents(config), [config]);
  const tracker = useMemo(() => createBrowserTracker({ sessionId: session.id, allowed }), [session.id, allowed]);
  useEffect(() => tracker.attach(), [tracker]);

  // One step_viewed per shown step; the ref keeps React's StrictMode double effect from doubling it.
  const viewedRef = useRef<string | null>(null);
  useEffect(() => {
    if (viewedRef.current === step.id) return;
    viewedRef.current = step.id;
    const position = progress(resolved, answers, step.id);
    tracker.track('step_viewed', {
      stepId: step.id,
      properties: {
        step_type: step.type,
        visible_step_index: position ? position.index : null,
        visible_step_count: position ? position.count : countableSteps(resolved, answers, config.progress),
      },
    });
    // Intentionally keyed by the step only: answers change together with the step.
  }, [step.id, tracker]);

  const position = progress(resolved, answers, step.id);
  const canGoBack = step.type !== 'result' && prevStepId(resolved, answers, step.id) !== null;

  function setDraftValue(value: DraftValue): void {
    setDraftState({ stepId: step.id, value, fieldError: null, failure: draft.failure });
  }

  async function submit(): Promise<void> {
    if (busy) return;
    const interactive = isInteractive(step);
    let nextAnswers = answers;

    if (interactive) {
      const validated = validateAnswer(step, draft.value);
      if (!validated.ok) {
        setDraftState({ ...draft, stepId: step.id, fieldError: validated.message, failure: null });
        return;
      }
      const key = answerKey(step);
      if (key !== null) {
        nextAnswers = { ...answers };
        if (validated.value === undefined) delete nextAnswers[key];
        else nextAnswers[key] = validated.value;
      }
    }

    const next = nextStepId(resolved, nextAnswers, step.id);
    if (next === null) return; // already on the last step of the sequence

    setBusy(true);
    setDraftState({ ...draft, stepId: step.id, fieldError: null, failure: null });
    try {
      await updateSessionState(session.id, { answers: nextAnswers, currentStepId: next });
      if (interactive) {
        tracker.track('answer_submitted', { stepId: step.id, properties: { answer_kind: answerKind(step) } });
      }
      tracker.track('step_completed', { stepId: step.id, properties: { next_step_id: next } });
      setAnswers(nextAnswers);
      setStepId(next);
    } catch (error) {
      setDraftState({ ...draft, stepId: step.id, fieldError: null, failure: { message: errorMessage(error), action: 'submit' } });
    } finally {
      setBusy(false);
    }
  }

  async function goBack(): Promise<void> {
    if (busy) return;
    const previous = prevStepId(resolved, answers, step.id);
    if (previous === null) return;

    tracker.track('back_clicked', { stepId: step.id, properties: { destination_step_id: previous } });
    setBusy(true);
    setDraftState({ ...draft, stepId: step.id, failure: null });
    try {
      await updateSessionState(session.id, { answers, currentStepId: previous });
      setStepId(previous);
    } catch (error) {
      setDraftState({ ...draft, stepId: step.id, failure: { message: errorMessage(error), action: 'back' } });
    } finally {
      setBusy(false);
    }
  }

  function renderStep() {
    const invalid = draft.fieldError !== null;
    switch (step.type) {
      case 'info':
        return <InfoStep step={step} />;
      case 'single-select':
        return (
          <SingleSelectStep
            step={step}
            value={typeof draft.value === 'string' ? draft.value : ''}
            onChange={setDraftValue}
            disabled={busy}
            invalid={invalid}
            errorId={ERROR_ID}
          />
        );
      case 'multi-select':
        return (
          <MultiSelectStep
            step={step}
            value={Array.isArray(draft.value) ? draft.value : []}
            onChange={setDraftValue}
            disabled={busy}
            invalid={invalid}
            errorId={ERROR_ID}
          />
        );
      case 'number':
        return (
          <NumberStep
            step={step}
            value={typeof draft.value === 'string' ? draft.value : ''}
            onChange={setDraftValue}
            onSubmit={() => void submit()}
            disabled={busy}
            invalid={invalid}
            errorId={ERROR_ID}
          />
        );
      case 'result':
        return (
          <ResultStep
            step={step}
            sessionId={session.id}
            allowed={allowed}
            track={(name, options) => tracker.track(name, options)}
            onRestart={onRestart}
          />
        );
      default:
        return <p className="step-helper">Unsupported step type.</p>;
    }
  }

  return (
    <div className="funnel">
      <div className="funnel-shell">
        <header className="funnel-top">
          <p className="brand">{config.title}</p>
          {position ? <ProgressBar index={position.index} count={position.count} /> : null}
        </header>

        <main className="card" key={step.id}>
          {renderStep()}
          {draft.fieldError ? (
            <p className="field-error" id={ERROR_ID} role="alert">
              {draft.fieldError}
            </p>
          ) : null}
        </main>

        <footer className="action-bar">
          {draft.failure ? (
            <div className="net-error" role="alert">
              <span>{draft.failure.message}</span>
              <button
                type="button"
                className="link-button"
                onClick={() => void (draft.failure?.action === 'back' ? goBack() : submit())}
              >
                Try again
              </button>
            </div>
          ) : null}

          {step.type === 'result' ? null : (
            <div className="action-row">
              <button
                type="button"
                className={`button button-primary${busy ? ' is-busy' : ''}`}
                disabled={busy}
                onClick={() => void submit()}
              >
                {step.content.primaryActionLabel ?? 'Continue'}
              </button>
              {canGoBack ? (
                <button type="button" className="button button-ghost" disabled={busy} onClick={() => void goBack()}>
                  Back
                </button>
              ) : null}
            </div>
          )}

          <p className="version-badge" title={`Assignment: ${session.assignmentSource}`}>
            v{config.version} · {session.variant}
          </p>
        </footer>
      </div>
    </div>
  );
}

function freshDraft(step: Step, answers: Answers): StepDraft {
  const key = answerKey(step);
  const stored = key === null ? undefined : answers[key];
  let value: DraftValue = '';
  if (step.type === 'multi-select') value = Array.isArray(stored) ? [...stored] : [];
  else if (stored !== undefined && !Array.isArray(stored)) value = String(stored);
  return { stepId: step.id, value, fieldError: null, failure: null };
}

function countableSteps(resolved: ResolvedFunnel, answers: Answers, settings: FunnelConfig['progress']): number {
  const steps = settings.countVisibleOnly ? visibleSteps(resolved, answers) : resolved.steps;
  return steps.filter((candidate) => !settings.excludeTypes.includes(candidate.type)).length;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Please try again.';
}
