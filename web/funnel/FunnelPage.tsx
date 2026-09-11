// The funnel screen. Nothing is hard-coded: steps, copy, validation and the event whitelist
// all come from the session's config version, rendered through the shared engine.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
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
  visibleSteps,
} from '../../shared/engine';
import { ApiRequestError, updateSessionState } from '../api';
import { createBrowserTracker } from '../tracker/browser';
import { formatNumberDraft, validateDraft } from './answerDraft';
import { ProgressBar } from './ProgressBar';
import { decidePop, initialDepth, readEntry, stampState } from './stepHistory';
import { InfoStep } from './steps/InfoStep';
import { MultiSelectStep } from './steps/MultiSelectStep';
import { NumberStep } from './steps/NumberStep';
import { ResultStep } from './steps/ResultStep';
import { SingleSelectStep } from './steps/SingleSelectStep';
import { useSession } from './useSession';

const ERROR_ID = 'step-error';

export function FunnelPage() {
  const { status, session, config, error, retry, restart } = useSession();

  // "Start again" removes the button that had focus; the fresh session's first step takes it instead.
  const [restarted, setRestarted] = useState(false);
  const handleRestart = useCallback(() => {
    setRestarted(true);
    restart();
  }, [restart]);

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
    if (error?.code === 'no_active_version') {
      return (
        <BootError
          title="This questionnaire isn't live yet"
          message="No version of the funnel has been published. Please check back shortly."
          onRetry={retry}
          retryLabel="Check again"
          showAdminLink
        />
      );
    }
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
        onRetry={handleRestart}
        retryLabel="Start again"
      />
    );
  }

  return (
    <FunnelRunner
      key={session.id}
      session={session}
      config={config}
      resolved={resolved}
      onRestart={handleRestart}
      focusOnMount={restarted}
    />
  );
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
  showAdminLink = false,
}: {
  title: string;
  message: string;
  onRetry: () => void;
  retryLabel?: string;
  showAdminLink?: boolean;
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
          {showAdminLink ? (
            <Link className="link-button" to="/admin">
              Operator? Publish a version in the admin
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type DraftValue = string | string[];

interface StepFailure {
  message: string;
  action: 'submit' | 'back' | 'restart';
}

interface StepDraft {
  stepId: string;
  value: DraftValue;
  fieldError: string | null;
  failure: StepFailure | null;
}

interface FunnelRunnerProps {
  session: SessionDto;
  config: FunnelConfig;
  resolved: ResolvedFunnel;
  onRestart: () => void;
  /** Move focus to the first step on mount too (after "Start again"), not only on step changes. */
  focusOnMount: boolean;
}

function FunnelRunner({ session, config, resolved, onRestart, focusOnMount }: FunnelRunnerProps) {
  const [answers, setAnswers] = useState<Answers>(session.answers);
  const [stepId, setStepId] = useState(() => resolveCurrentStep(resolved, session.answers, session.currentStepId).id);
  const [busy, setBusy] = useState(false);
  // The popstate handler runs outside React's render, so it reads "saving" from a ref.
  const busyRef = useRef(false);
  function setSaving(value: boolean): void {
    busyRef.current = value;
    setBusy(value);
  }

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

  // Focus follows navigation: the card is remounted per step, so whatever had focus is gone.
  // Landing on the new heading gets it read out and puts keyboard users at the top of the
  // question. The first mount is skipped (unless restarting) so a page load never steals focus.
  const mainRef = useRef<HTMLElement>(null);
  const focusedStepRef = useRef<string | null>(focusOnMount ? null : step.id);
  const managesFocusRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusedStepRef.current === step.id) return; // first mount, or StrictMode's second run
    focusedStepRef.current = step.id;
    managesFocusRef.current = true;
    focusStepHeading(mainRef.current);
  }, [step.id]);

  /** The result screen swaps loading → ready / error inside one step; re-place focus it dropped. */
  function rescueFocus(): void {
    if (!managesFocusRef.current) return;
    const active = document.activeElement;
    if (active === null || active === document.body) focusStepHeading(mainRef.current);
  }

  // ---- Browser / Android back (decisions in ./stepHistory.ts) ----
  // uiDepth: the history depth the step on screen belongs to. entryDepth: the depth of the entry
  // the browser is on. They differ only between a popstate and the navigation it triggers.
  const uiDepthRef = useRef(0);
  const entryDepthRef = useRef(0);
  const mountStepIdRef = useRef(step.id);
  const onPopRef = useRef<(state: unknown) => void>(() => undefined);

  function writeEntry(mode: 'push' | 'replace', entryStepId: string, depth: number): void {
    const state = stampState(window.history.state, { sessionId: session.id, stepId: entryStepId, depth });
    try {
      // No URL argument: the address stays as it is, so a shared link never lands mid-funnel.
      if (mode === 'push') window.history.pushState(state, '');
      else window.history.replaceState(state, '');
      entryDepthRef.current = depth;
    } catch {
      // Browsers throttle history calls; the funnel keeps working, only browser back is coarser.
    }
  }

  /** After a navigation settles, move the browser to the entry of the step on screen. */
  function syncHistory(shownStepId: string): void {
    const delta = uiDepthRef.current - entryDepthRef.current;
    if (delta === 0) writeEntry('replace', shownStepId, uiDepthRef.current);
    else window.history.go(delta);
  }

  useEffect(() => {
    // The bootstrap entry is replaced, not pushed; a reload keeps the tab's entries and its depth.
    const depth = initialDepth(window.history.state, session.id);
    uiDepthRef.current = depth;
    writeEntry('replace', mountStepIdRef.current, depth);
    const onPopState = (event: PopStateEvent) => onPopRef.current(event.state);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // Once per runner; the runner is keyed by the session id.
  }, []);

  useEffect(() => {
    onPopRef.current = (state: unknown) => {
      const entry = readEntry(state);
      if (entry !== null && entry.sessionId === session.id) entryDepthRef.current = entry.depth;
      const decision = decidePop(entry, {
        sessionId: session.id,
        uiDepth: uiDepthRef.current,
        busy: busyRef.current,
        canGoBack: prevStepId(resolved, answers, step.id) !== null,
      });
      switch (decision.kind) {
        case 'back':
          void goBack();
          break;
        case 'realign':
          window.history.go(decision.delta);
          break;
        case 'skip':
          window.history.back();
          break;
        case 'accept':
          if (entry !== null) {
            uiDepthRef.current = entry.depth;
            writeEntry('replace', step.id, entry.depth);
          }
          break;
        case 'ignore':
          break;
      }
    };
  });

  const position = progress(resolved, answers, step.id);
  // The result has no Back button (browser back from it still returns to the last question).
  const showBack = step.type !== 'result' && prevStepId(resolved, answers, step.id) !== null;

  function setDraftValue(value: DraftValue): void {
    if (busy) return; // inputs stay focusable while saving, so edits are ignored here instead
    setDraftState({ stepId: step.id, value, fieldError: null, failure: draft.failure });
  }

  async function submit(): Promise<void> {
    if (busyRef.current) return;
    const interactive = isInteractive(step);
    let nextAnswers = answers;

    if (interactive) {
      const validated = validateDraft(step, draft.value);
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

    setSaving(true);
    setDraftState({ ...draft, stepId: step.id, fieldError: null, failure: null });
    try {
      await updateSessionState(session.id, { answers: nextAnswers, currentStepId: next });
      if (interactive) {
        tracker.track('answer_submitted', { stepId: step.id, properties: { answer_kind: answerKind(step) } });
      }
      tracker.track('step_completed', { stepId: step.id, properties: { next_step_id: next } });
      setAnswers(nextAnswers);
      setStepId(next);
      const depth = entryDepthRef.current + 1;
      uiDepthRef.current = depth;
      writeEntry('push', next, depth);
    } catch (error) {
      const rejection = answerRejection(error);
      setDraftState({
        ...draft,
        stepId: step.id,
        fieldError: rejection,
        failure: rejection === null ? failureFor(error, 'submit') : null,
      });
    } finally {
      setSaving(false);
    }
  }

  /** The back navigation itself, shared by the Back button and browser / Android back. */
  async function goBack(): Promise<void> {
    if (busyRef.current) return;
    const previous = prevStepId(resolved, answers, step.id);
    if (previous === null) return;

    setSaving(true);
    setDraftState({ ...draft, stepId: step.id, failure: null });
    let shown = step.id;
    try {
      await updateSessionState(session.id, { answers, currentStepId: previous });
      // Once per completed navigation: never for a failed attempt, never twice for a retry.
      tracker.track('back_clicked', { stepId: step.id, properties: { destination_step_id: previous } });
      setStepId(previous);
      shown = previous;
      uiDepthRef.current = Math.max(0, uiDepthRef.current - 1);
    } catch (error) {
      setDraftState({ ...draft, stepId: step.id, failure: failureFor(error, 'back') });
    } finally {
      setSaving(false);
    }
    // After a failure this returns the browser to the step still on screen.
    syncHistory(shown);
  }

  /**
   * With a funnel entry behind this one, the browser moves first and the popstate runs goBack(), so
   * the browser's stack keeps mirroring the steps. A session resumed in a fresh tab has no entry
   * behind it: then goBack() runs directly and the current entry is re-stamped.
   */
  function requestBack(): void {
    if (busyRef.current || prevStepId(resolved, answers, step.id) === null) return;
    if (entryDepthRef.current > 0 && entryDepthRef.current === uiDepthRef.current) window.history.back();
    else void goBack();
  }

  function retryFailure(failure: StepFailure): void {
    if (failure.action === 'restart') onRestart();
    else if (failure.action === 'back') requestBack();
    else void submit();
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
            busy={busy}
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
            busy={busy}
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
            busy={busy}
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
            onStatusChange={rescueFocus}
          />
        );
      default:
        return <p className="step-helper">Unsupported step type.</p>;
    }
  }

  // Back sits at the top, away from Continue: in the footer a tap meant for Continue landed on
  // Back once the button row shifted. aria-disabled, not disabled, keeps focus while saving.
  const backButton = showBack ? (
    <button type="button" className="back-link" aria-disabled={busy || undefined} onClick={requestBack}>
      <span aria-hidden="true">←</span> Back
    </button>
  ) : null;

  return (
    <div className="funnel">
      <div className="funnel-shell">
        <header className="funnel-top">
          <p className="brand">{config.title}</p>
          {position ? (
            <ProgressBar index={position.index} count={position.count} start={backButton} />
          ) : backButton ? (
            <div className="progress-meta">{backButton}</div>
          ) : null}
        </header>

        <main className="card" key={step.id} ref={mainRef} tabIndex={-1} aria-busy={busy || undefined}>
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
                onClick={() => draft.failure && retryFailure(draft.failure)}
              >
                {draft.failure.action === 'restart' ? 'Start again' : 'Try again'}
              </button>
            </div>
          ) : null}

          {step.type === 'result' ? null : (
            // submit() ignores clicks while busy; see backButton for why this is aria-disabled.
            <button
              type="button"
              className={`button button-primary${busy ? ' is-busy' : ''}`}
              aria-disabled={busy || undefined}
              onClick={() => void submit()}
            >
              {step.content.primaryActionLabel ?? 'Continue'}
            </button>
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
  else if (typeof stored === 'number') value = formatNumberDraft(stored);
  else if (stored !== undefined && !Array.isArray(stored)) value = String(stored);
  return { stepId: step.id, value, fieldError: null, failure: null };
}

/** Focuses the step's h1 (tabIndex -1), or the card itself when the step has no title. */
function focusStepHeading(container: HTMLElement | null): void {
  if (!container) return;
  const target = container.querySelector<HTMLElement>('h1[tabindex]') ?? container;
  target.focus({ preventScroll: true });
  // A new question starts at the top; plain focus() could park the heading under the sticky bar.
  if (window.scrollY > 0) window.scrollTo({ top: 0 });
}

function countableSteps(resolved: ResolvedFunnel, answers: Answers, settings: FunnelConfig['progress']): number {
  const steps = settings.countVisibleOnly ? visibleSteps(resolved, answers) : resolved.steps;
  return steps.filter((candidate) => !settings.excludeTypes.includes(candidate.type)).length;
}

/**
 * The server re-validates answers with the same engine, so a 400 there belongs under the field;
 * retrying the identical request would only fail again.
 */
function answerRejection(error: unknown): string | null {
  if (!(error instanceof ApiRequestError) || error.status !== 400) return null;
  if (error.code !== 'invalid_answer' && error.code !== 'unknown_answer') return null;
  const details = error.details as { message?: unknown } | null | undefined;
  return typeof details?.message === 'string' ? details.message : error.message;
}

/** A session that vanished or expired mid-funnel cannot be retried — offer a fresh start instead. */
function failureFor(error: unknown, action: 'submit' | 'back'): StepFailure {
  if (error instanceof ApiRequestError && (error.status === 404 || error.status === 410)) {
    return { message: 'This session has expired. Start again to continue.', action: 'restart' };
  }
  const message = error instanceof ApiRequestError ? error.message : 'Something went wrong. Please try again.';
  return { message, action };
}
