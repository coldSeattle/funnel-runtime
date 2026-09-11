import type { ReactNode } from 'react';
import type { Progress } from '../../shared/engine';

interface ProgressBarProps extends Progress {
  /** Rendered at the start of the label row, above the bar (the funnel's Back button). */
  start?: ReactNode;
}

export function ProgressBar({ index, count, start }: ProgressBarProps) {
  const percent = count > 0 ? Math.round((index / count) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress-meta">
        {start}
        <p className="progress-label">
          Question {index} of {count}
        </p>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={index}
        aria-label={`Question ${index} of ${count}`}
      >
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
