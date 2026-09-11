import { useEffect, useRef, useState } from 'react';
import type { ResultDef, Step } from '../../../shared/types';
import { ApiRequestError, computeSessionResult } from '../../api';
import type { TrackOptions } from '../../tracker/core';

export interface ResultStepProps {
  step: Step;
  sessionId: string;
  /** Event names the session's config version allows — v1 has no recommendation_expanded. */
  allowed: Map<string, Set<string>>;
  track: (name: string, options?: TrackOptions) => void;
  onRestart: () => void;
  /** Called after loading / ready / error swaps the content, so the runner can re-place focus. */
  onStatusChange?: () => void;
}

type ResultState =
  | { status: 'loading' }
  | { status: 'ready'; result: ResultDef }
  | { status: 'error'; message: string };

const ACTION_LIST_ID = 'result-action-list';

// Copy that is not in the config stays neutral: variant framing (e.g. B's "30-day" wording) must
// come from the config only, or it would leak into the other arm of the experiment.
export function ResultStep({ step, sessionId, allowed, track, onRestart, onStatusChange }: ResultStepProps) {
  const [state, setState] = useState<ResultState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const startedRef = useRef(-1);
  const ctaTrackedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current === attempt) return; // StrictMode double effect
    startedRef.current = attempt;
    setState({ status: 'loading' });
    computeSessionResult(sessionId).then(
      ({ result }) => {
        setState({ status: 'ready', result });
        track('result_viewed', { stepId: step.id, properties: { result_id: result.id } });
      },
      (error: unknown) => {
        const message =
          error instanceof ApiRequestError ? error.message : 'The recommendation could not be built right now.';
        setState({ status: 'error', message });
      },
    );
    // `track` and `step.id` are stable for the lifetime of this screen.
  }, [attempt, sessionId]);

  useEffect(() => {
    onStatusChange?.();
    // Only the status matters: each status renders a fresh subtree (see the keys below).
  }, [state.status]);

  /** The first click is the conversion and is tracked once; later clicks only show or hide the list. */
  function handleCta(result: ResultDef): void {
    const action = result.cta.action;
    const expands = action === 'expand_recommendation';
    if (ctaTrackedRef.current) {
      if (expands) setExpanded((open) => !open);
      return;
    }
    ctaTrackedRef.current = true;
    track('cta_clicked', { stepId: step.id, properties: { result_id: result.id, action } });
    if (!expands) return;
    setExpanded(true);
    if (allowed.has('recommendation_expanded')) {
      track('recommendation_expanded', {
        stepId: step.id,
        properties: { result_id: result.id, action, source: 'cta' },
      });
    }
  }

  if (state.status === 'loading') {
    return (
      <div key="loading" className="step step-result is-loading" aria-busy="true">
        <div className="result-spinner" aria-hidden="true" />
        <h1 className="step-title" tabIndex={-1}>
          {step.content.loadingTitle ?? 'Building your recommendation…'}
        </h1>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div key="error" className="step step-result is-error">
        <h1 className="step-title" tabIndex={-1}>
          {step.content.errorTitle ?? 'We could not build the recommendation'}
        </h1>
        <p className="step-helper">{state.message}</p>
        <button type="button" className="button button-primary" onClick={() => setAttempt((n) => n + 1)}>
          {step.content.retryLabel ?? 'Try again'}
        </button>
        <button type="button" className="link-button" onClick={onRestart}>
          Start again
        </button>
      </div>
    );
  }

  const { result } = state;
  const expands = result.cta.action === 'expand_recommendation';
  return (
    <div key="ready" className="step step-result">
      <p className="eyebrow">Your recommendation</p>
      <h1 className="step-title" tabIndex={-1}>
        {result.title}
      </h1>
      <p className="result-summary">{result.summary}</p>

      <button
        type="button"
        className="button button-primary"
        aria-expanded={expands ? expanded : undefined}
        aria-controls={expands && expanded ? ACTION_LIST_ID : undefined}
        onClick={() => handleCta(result)}
      >
        {expands && expanded ? 'Hide the action list' : result.cta.label}
      </button>

      {expanded ? (
        <section className="recommendations" id={ACTION_LIST_ID} aria-labelledby={`${ACTION_LIST_ID}-title`}>
          <h2 className="recommendations-title" id={`${ACTION_LIST_ID}-title`}>
            Your action list
          </h2>
          <ol className="recommendation-list">
            {result.recommendations.map((item, index) => (
              <li key={item} style={{ animationDelay: `${index * 60}ms` }}>
                {item}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <button type="button" className="link-button" onClick={onRestart}>
        Start again
      </button>
    </div>
  );
}
