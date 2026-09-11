import type { StepContent } from '../../../shared/types';

export function StepHeader({ content }: { content: StepContent }) {
  return (
    <header className="step-header">
      {content.eyebrow ? <p className="eyebrow">{content.eyebrow}</p> : null}
      {content.title ? (
        // Focus target when the step changes (see focusStepHeading in FunnelPage).
        <h1 className="step-title" tabIndex={-1}>
          {content.title}
        </h1>
      ) : null}
      {content.helperText ? <p className="step-helper">{content.helperText}</p> : null}
    </header>
  );
}
