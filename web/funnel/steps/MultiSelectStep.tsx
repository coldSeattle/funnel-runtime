import type { Step } from '../../../shared/types';
import { StepHeader } from './StepHeader';

export interface MultiSelectStepProps {
  step: Step;
  value: string[];
  /** Ignored by the runner while a save is in flight. */
  onChange: (value: string[]) => void;
  /** Marks the chips unavailable without `disabled`, which would drop keyboard focus. */
  busy: boolean;
  invalid: boolean;
  errorId: string;
}

export function MultiSelectStep({ step, value, onChange, busy, invalid, errorId }: MultiSelectStepProps) {
  const options = step.input?.options ?? [];
  const max = step.validation?.maxSelections;

  function toggle(optionValue: string): void {
    onChange(value.includes(optionValue) ? value.filter((v) => v !== optionValue) : [...value, optionValue]);
  }

  return (
    <div className="step step-multi">
      <StepHeader content={step.content} />
      <div
        className="chips"
        role="group"
        aria-label={step.content.title}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
      >
        {options.map((option) => (
          <label key={option.value} className={`chip${value.includes(option.value) ? ' is-selected' : ''}`}>
            <input
              type="checkbox"
              name={step.input?.name ?? step.id}
              value={option.value}
              checked={value.includes(option.value)}
              aria-disabled={busy || undefined}
              onChange={() => toggle(option.value)}
            />
            <span className="chip-label">{option.label}</span>
          </label>
        ))}
      </div>
      {max !== undefined ? (
        <p className={`select-counter${value.length > max ? ' is-over' : ''}`} aria-live="polite">
          {value.length} of {max} selected
        </p>
      ) : null}
    </div>
  );
}
