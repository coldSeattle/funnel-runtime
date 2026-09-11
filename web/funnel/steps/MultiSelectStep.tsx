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

/**
 * Checkbox chips. Once maxSelections is reached the remaining chips are marked unavailable, so the
 * answer can never go over the limit; the engine's maxSelections check stays as a safety net.
 */
export function MultiSelectStep({ step, value, onChange, busy, invalid, errorId }: MultiSelectStepProps) {
  const options = step.input?.options ?? [];
  const max = step.validation?.maxSelections;
  const full = max !== undefined && value.length >= max;
  const counterId = `${step.id}-counter`;
  const describedBy = [max !== undefined ? counterId : null, invalid ? errorId : null].filter(Boolean).join(' ');

  function toggle(optionValue: string): void {
    const selected = value.includes(optionValue);
    if (!selected && full) return; // the browser still toggles an aria-disabled checkbox
    onChange(selected ? value.filter((v) => v !== optionValue) : [...value, optionValue]);
  }

  return (
    <div className="step step-multi">
      <StepHeader content={step.content} />
      <div
        className="chips"
        role="group"
        aria-label={step.content.title}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
      >
        {options.map((option) => {
          const selected = value.includes(option.value);
          // aria-disabled, not disabled: the chip stays in the tab order and says why it is unavailable.
          const blocked = full && !selected;
          return (
            <label
              key={option.value}
              className={`chip${selected ? ' is-selected' : ''}${blocked ? ' is-blocked' : ''}`}
            >
              <input
                type="checkbox"
                name={step.input?.name ?? step.id}
                value={option.value}
                checked={selected}
                aria-disabled={busy || blocked || undefined}
                onChange={() => toggle(option.value)}
              />
              <span className="chip-label">{option.label}</span>
            </label>
          );
        })}
      </div>
      {max !== undefined ? (
        <p
          id={counterId}
          className={`select-counter${value.length > max ? ' is-over' : full ? ' is-full' : ''}`}
          aria-live="polite"
        >
          {value.length} of {max} selected{full ? ' — deselect one to change' : ''}
        </p>
      ) : null}
    </div>
  );
}
