import type { Step } from '../../../shared/types';
import { StepHeader } from './StepHeader';

export interface SingleSelectStepProps {
  step: Step;
  value: string;
  /** Ignored by the runner while a save is in flight. */
  onChange: (value: string) => void;
  /** Marks the options unavailable without `disabled`, which would drop keyboard focus. */
  busy: boolean;
  invalid: boolean;
  errorId: string;
}

/** Radio inputs behind option cards: arrow-key navigation and focus rings come for free. */
export function SingleSelectStep({ step, value, onChange, busy, invalid, errorId }: SingleSelectStepProps) {
  const options = step.input?.options ?? [];
  return (
    <div className="step step-single">
      <StepHeader content={step.content} />
      <div
        className="options"
        role="radiogroup"
        aria-label={step.content.title}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
      >
        {options.map((option) => (
          <label key={option.value} className={`option${value === option.value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={step.input?.name ?? step.id}
              value={option.value}
              checked={value === option.value}
              aria-disabled={busy || undefined}
              onChange={() => onChange(option.value)}
            />
            <span className="option-label">{option.label}</span>
            <span className="option-mark" aria-hidden="true" />
          </label>
        ))}
      </div>
    </div>
  );
}
