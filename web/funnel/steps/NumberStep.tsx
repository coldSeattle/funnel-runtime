import type { Step } from '../../../shared/types';
import { StepHeader } from './StepHeader';

export interface NumberStepProps {
  step: Step;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  invalid: boolean;
  errorId: string;
}

export function NumberStep({ step, value, onChange, onSubmit, disabled, invalid, errorId }: NumberStepProps) {
  const input = step.input;
  const inputId = `field-${step.id}`;
  const range =
    input?.min !== undefined && input.max !== undefined ? `${input.min}–${input.max}${input.unit ? ` ${input.unit}` : ''}` : null;

  return (
    <div className="step step-number">
      <StepHeader content={step.content} />
      <div className={`number-field${invalid ? ' is-invalid' : ''}`}>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          autoComplete="off"
          className="number-input"
          value={value}
          min={input?.min}
          max={input?.max}
          step={input?.step}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
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
      {range ? <p className="field-hint">Allowed range: {range}</p> : null}
    </div>
  );
}
