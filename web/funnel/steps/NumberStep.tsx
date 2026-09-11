import type { Step } from '../../../shared/types';
import { StepHeader } from './StepHeader';

export interface NumberStepProps {
  step: Step;
  /** Raw text as typed; validateAnswer parses it and words the error. */
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** A save is in flight: the field locks but stays focusable (a disabled field would drop focus). */
  busy: boolean;
  invalid: boolean;
  errorId: string;
}

/**
 * A text input with a numeric keyboard, not type="number": a number input reports "" for text it
 * cannot parse, so the field would show "abc" while the draft said "empty" and the error said
 * "required". Here the draft is exactly what is on screen.
 */
export function NumberStep({ step, value, onChange, onSubmit, busy, invalid, errorId }: NumberStepProps) {
  const input = step.input;
  const inputId = `field-${step.id}`;
  const hintId = `${inputId}-hint`;
  const range =
    input?.min !== undefined && input.max !== undefined ? `${input.min}–${input.max}${input.unit ? ` ${input.unit}` : ''}` : null;
  const describedBy = [range ? hintId : null, invalid ? errorId : null].filter(Boolean).join(' ');
  // Phone keypads for "numeric" have no minus or decimal separator.
  const inputMode =
    input?.min !== undefined && input.min < 0 ? 'text' : Number.isInteger(input?.step ?? Number.NaN) ? 'numeric' : 'decimal';

  return (
    <div className="step step-number">
      <StepHeader content={step.content} />
      <div className={`number-field${invalid ? ' is-invalid' : ''}`}>
        <input
          id={inputId}
          type="text"
          inputMode={inputMode}
          enterKeyHint="next"
          autoComplete="off"
          spellCheck={false}
          className="number-input"
          value={value}
          readOnly={busy}
          aria-disabled={busy || undefined}
          aria-label={step.content.title}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        {input?.unit ? <span className="number-unit">{input.unit}</span> : null}
      </div>
      {range ? (
        <p className="field-hint" id={hintId}>
          Allowed range: {range}
        </p>
      ) : null}
    </div>
  );
}
