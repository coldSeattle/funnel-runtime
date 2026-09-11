import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

// Schema is additive-only: new event names or properties never require a migration
// because events are stored as name + properties_json. See docs/design.md §4.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS funnels (
  funnel_id       TEXT PRIMARY KEY,
  active_version  INTEGER
);

CREATE TABLE IF NOT EXISTS funnel_versions (
  funnel_id     TEXT    NOT NULL,
  version       INTEGER NOT NULL,
  config_json   TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  published_at  TEXT,
  PRIMARY KEY (funnel_id, version)
);

CREATE TABLE IF NOT EXISTS version_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  funnel_id     TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  from_version  INTEGER,
  to_version    INTEGER NOT NULL,
  at            TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  funnel_id          TEXT    NOT NULL,
  version            INTEGER NOT NULL,
  variant            TEXT    NOT NULL,
  experiment_id      TEXT,
  assignment_source  TEXT    NOT NULL,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  answers_json       TEXT    NOT NULL DEFAULT '{}',
  current_step_id    TEXT,
  result_id          TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  expires_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_version ON sessions(funnel_id, version);

CREATE TABLE IF NOT EXISTS events (
  event_id           TEXT PRIMARY KEY,
  session_id         TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  client_timestamp   TEXT    NOT NULL,
  server_timestamp   TEXT    NOT NULL,
  funnel_id          TEXT    NOT NULL,
  funnel_version     INTEGER NOT NULL,
  experiment_id      TEXT,
  variant            TEXT    NOT NULL,
  assignment_source  TEXT    NOT NULL,
  step_id            TEXT,
  utm_source         TEXT,
  utm_medium         TEXT,
  utm_campaign       TEXT,
  properties_json    TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
CREATE INDEX IF NOT EXISTS idx_events_version_variant ON events(funnel_version, variant);
`;

export function openDb(path: string): Db {
  const inMemory = path === ':memory:';
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
