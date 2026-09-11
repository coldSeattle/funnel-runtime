import type { Step } from '../../../shared/types';
import { StepHeader } from './StepHeader';

export function InfoStep({ step }: { step: Step }) {
  return (
    <div className="step step-info">
      <StepHeader content={step.content} />
      {step.content.body ? <p className="step-body">{step.content.body}</p> : null}
    </div>
  );
}
