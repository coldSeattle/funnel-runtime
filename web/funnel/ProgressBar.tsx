import type { Progress } from '../../shared/engine';

export function ProgressBar({ index, count }: Progress) {
  const percent = count > 0 ? Math.round((index / count) * 100) : 0;
  return (
    <div className="progress">
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
      <p className="progress-label">
        Question {index} of {count}
      </p>
    </div>
  );
}
