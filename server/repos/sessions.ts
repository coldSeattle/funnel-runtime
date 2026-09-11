import type { Db } from '../db';
import type { AssignmentSource } from '../../shared/api';

export interface SessionRow {
  id: string;
  funnel_id: string;
  version: number;
  variant: string;
  experiment_id: string | null;
  assignment_source: AssignmentSource;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  answers_json: string;
  current_step_id: string | null;
  result_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface SessionsRepo {
  insert(row: SessionRow): void;
  getById(id: string): SessionRow | undefined;
  updateState(id: string, answersJson: string, currentStepId: string, updatedAt: string): void;
  setResult(id: string, resultId: string, updatedAt: string): void;
  count(): number;
  /** Distinct non-null campaigns, sorted — the analytics filter options. */
  campaigns(): string[];
}

export function createSessionsRepo(db: Db): SessionsRepo {
  const insert = db.prepare(
    `INSERT INTO sessions (id, funnel_id, version, variant, experiment_id, assignment_source,
       utm_source, utm_medium, utm_campaign, answers_json, current_step_id, result_id,
       created_at, updated_at, expires_at)
     VALUES (@id, @funnel_id, @version, @variant, @experiment_id, @assignment_source,
       @utm_source, @utm_medium, @utm_campaign, @answers_json, @current_step_id, @result_id,
       @created_at, @updated_at, @expires_at)`,
  );
  const selectById = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const updateState = db.prepare('UPDATE sessions SET answers_json = ?, current_step_id = ?, updated_at = ? WHERE id = ?');
  const setResult = db.prepare('UPDATE sessions SET result_id = ?, updated_at = ? WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS n FROM sessions');
  const campaigns = db.prepare(
    "SELECT DISTINCT utm_campaign FROM sessions WHERE utm_campaign IS NOT NULL AND utm_campaign <> '' ORDER BY utm_campaign ASC",
  );

  return {
    insert: (row) => void insert.run(row),
    getById: (id) => selectById.get(id) as SessionRow | undefined,
    updateState: (id, answersJson, currentStepId, updatedAt) => void updateState.run(answersJson, currentStepId, updatedAt, id),
    setResult: (id, resultId, updatedAt) => void setResult.run(resultId, updatedAt, id),
    count: () => (count.get() as { n: number }).n,
    campaigns: () => (campaigns.all() as { utm_campaign: string }[]).map((r) => r.utm_campaign),
  };
}
