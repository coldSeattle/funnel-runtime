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
}

type ResultState =
  | { status: 'loading' }
  | { status: 'ready'; result: ResultDef }
  | { status: 'error'; message: string };

export function ResultStep({ step, sessionId, allowed, track, onRestart }: ResultStepProps) {
  const [state, setState] = useState<ResultState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const startedRef = useRef(-1);

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

  function handleCta(result: ResultDef): void {
    const action = result.cta.action;
    track('cta_clicked', { stepId: step.id, properties: { result_id: result.id, action } });
    if (action !== 'expand_recommendation') return;
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
      <div className="step step-result is-loading" aria-busy="true">
        <div className="result-spinner" aria-hidden="true" />
        <h1 className="step-title">{step.content.loadingTitle ?? 'Building your recommendation…'}</h1>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="step step-result is-error">
        <h1 className="step-title">{step.content.errorTitle ?? 'We could not build the recommendation'}</h1>
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
  return (
    <div className="step step-result">
      <p className="eyebrow">Your recommendation</p>
      <h1 className="step-title">{result.title}</h1>
      <p className="result-summary">{result.summary}</p>

      <button type="button" className="button button-primary" onClick={() => handleCta(result)}>
        {result.cta.label}
      </button>

      {expanded ? (
        <section className="recommendations" aria-label="Action list">
          <h2 className="recommendations-title">What to do in the next 30 days</h2>
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
