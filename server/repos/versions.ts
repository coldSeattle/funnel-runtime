import type { Db } from '../db';

export interface FunnelRow {
  funnel_id: string;
  active_version: number | null;
}

export interface VersionRow {
  funnel_id: string;
  version: number;
  config_json: string;
  created_at: string;
  published_at: string | null;
}

export interface HistoryRow {
  id: number;
  funnel_id: string;
  action: 'publish' | 'rollback';
  from_version: number | null;
  to_version: number;
  at: string;
}

export interface VersionsRepo {
  getFunnel(): FunnelRow | undefined;
  createFunnel(funnelId: string): void;
  setActiveVersion(funnelId: string, version: number): void;
  insertVersion(row: VersionRow): void;
  getVersion(funnelId: string, version: number): VersionRow | undefined;
  listVersions(funnelId: string): VersionRow[];
  markPublished(funnelId: string, version: number, at: string): void;
  countSessionsByVersion(funnelId: string): Map<number, number>;
  insertHistory(row: Omit<HistoryRow, 'id'>): void;
  listHistory(funnelId: string): HistoryRow[];
  latestHistory(funnelId: string): HistoryRow | undefined;
}

/** Only one funnel is supported by the UI, so the funnel row is read without an id where possible. */
export function createVersionsRepo(db: Db): VersionsRepo {
  const selectFunnel = db.prepare('SELECT funnel_id, active_version FROM funnels LIMIT 1');
  const insertFunnel = db.prepare('INSERT INTO funnels (funnel_id, active_version) VALUES (?, NULL)');
  const updateActive = db.prepare('UPDATE funnels SET active_version = ? WHERE funnel_id = ?');
  const insertVersion = db.prepare(
    `INSERT INTO funnel_versions (funnel_id, version, config_json, created_at, published_at)
     VALUES (@funnel_id, @version, @config_json, @created_at, @published_at)`,
  );
  const selectVersion = db.prepare('SELECT * FROM funnel_versions WHERE funnel_id = ? AND version = ?');
  const selectVersions = db.prepare('SELECT * FROM funnel_versions WHERE funnel_id = ? ORDER BY version ASC');
  const setPublishedAt = db.prepare(
    'UPDATE funnel_versions SET published_at = ? WHERE funnel_id = ? AND version = ? AND published_at IS NULL',
  );
  const countSessions = db.prepare('SELECT version, COUNT(*) AS n FROM sessions WHERE funnel_id = ? GROUP BY version');
  const insertHistory = db.prepare(
    `INSERT INTO version_history (funnel_id, action, from_version, to_version, at)
     VALUES (@funnel_id, @action, @from_version, @to_version, @at)`,
  );
  const selectHistory = db.prepare('SELECT * FROM version_history WHERE funnel_id = ? ORDER BY id ASC');
  const selectLatestHistory = db.prepare('SELECT * FROM version_history WHERE funnel_id = ? ORDER BY id DESC LIMIT 1');

  return {
    getFunnel: () => selectFunnel.get() as FunnelRow | undefined,
    createFunnel: (funnelId) => void insertFunnel.run(funnelId),
    setActiveVersion: (funnelId, version) => void updateActive.run(version, funnelId),
    insertVersion: (row) => void insertVersion.run(row),
    getVersion: (funnelId, version) => selectVersion.get(funnelId, version) as VersionRow | undefined,
    listVersions: (funnelId) => selectVersions.all(funnelId) as VersionRow[],
    markPublished: (funnelId, version, at) => void setPublishedAt.run(at, funnelId, version),
    countSessionsByVersion: (funnelId) => {
      const rows = countSessions.all(funnelId) as { version: number; n: number }[];
      return new Map(rows.map((r) => [r.version, r.n]));
    },
    insertHistory: (row) => void insertHistory.run(row),
    listHistory: (funnelId) => selectHistory.all(funnelId) as HistoryRow[],
    latestHistory: (funnelId) => selectLatestHistory.get(funnelId) as HistoryRow | undefined,
  };
}
