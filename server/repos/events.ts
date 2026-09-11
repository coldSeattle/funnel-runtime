import type { Db } from '../db';
import type { AssignmentSource } from '../../shared/api';

export interface EventRow {
  event_id: string;
  session_id: string;
  name: string;
  client_timestamp: string;
  server_timestamp: string;
  funnel_id: string;
  funnel_version: number;
  experiment_id: string | null;
  variant: string;
  assignment_source: AssignmentSource;
  step_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  properties_json: string;
}

/** The columns analytics aggregates over; everything else stays in the database. */
export interface AnalyticsEventRow {
  session_id: string;
  name: string;
  step_id: string | null;
  client_timestamp: string;
  server_timestamp: string;
  variant: string;
  funnel_version: number;
}

export interface EventFilters {
  version?: number;
  variant?: string;
  utmCampaign?: string;
  excludeOverrides?: boolean;
}

export interface EventsRepo {
  /** INSERT OR IGNORE on the event_id primary key: returns false when the event was already stored. */
  insert(row: EventRow): boolean;
  queryEvents(filters: EventFilters): AnalyticsEventRow[];
  bySession(sessionId: string): EventRow[];
  count(): number;
  /** Runs fn inside one SQLite transaction (a batch of inserts is much faster that way). */
  transaction<T>(fn: () => T): T;
}

export function createEventsRepo(db: Db): EventsRepo {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (event_id, session_id, name, client_timestamp, server_timestamp,
       funnel_id, funnel_version, experiment_id, variant, assignment_source, step_id,
       utm_source, utm_medium, utm_campaign, properties_json)
     VALUES (@event_id, @session_id, @name, @client_timestamp, @server_timestamp,
       @funnel_id, @funnel_version, @experiment_id, @variant, @assignment_source, @step_id,
       @utm_source, @utm_medium, @utm_campaign, @properties_json)`,
  );
  const bySession = db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY client_timestamp ASC, server_timestamp ASC');
  const count = db.prepare('SELECT COUNT(*) AS n FROM events');

  return {
    insert: (row) => insert.run(row).changes > 0,

    queryEvents(filters) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters.version !== undefined) {
        where.push('funnel_version = ?');
        params.push(filters.version);
      }
      if (filters.variant !== undefined) {
        where.push('variant = ?');
        params.push(filters.variant);
      }
      if (filters.utmCampaign !== undefined) {
        where.push('utm_campaign = ?');
        params.push(filters.utmCampaign);
      }
      if (filters.excludeOverrides) where.push("assignment_source <> 'override'");
      const sql =
        `SELECT session_id, name, step_id, client_timestamp, server_timestamp, variant, funnel_version FROM events` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '');
      return db.prepare(sql).all(...params) as AnalyticsEventRow[];
    },

    bySession: (sessionId) => bySession.all(sessionId) as EventRow[],
    count: () => (count.get() as { n: number }).n,
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}
