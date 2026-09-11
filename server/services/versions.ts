import type { Db } from '../db';
import { HttpError } from '../errors';
import { createVersionsRepo, type VersionsRepo } from '../repos/versions';
import { safeParseFunnelConfig } from '../../shared/schema';
import type { FunnelConfig } from '../../shared/types';
import type { HistoryResponse, VersionStatus, VersionSummary, VersionsResponse } from '../../shared/api';

export interface ActiveVersion {
  version: number;
  config: FunnelConfig;
}

export interface VersionsService {
  upload(raw: unknown): { version: number };
  publish(version: number): { activeVersion: number; fromVersion: number | null };
  rollback(): { activeVersion: number; fromVersion: number | null };
  list(): VersionsResponse;
  history(): HistoryResponse;
  /** Parsed config of a stored version; cached because sessions read it on every request. */
  getConfig(version: number): FunnelConfig | null;
  getActive(): ActiveVersion | null;
  activeVersion(): number | null;
  funnelId(): string | null;
  storedVersions(): number[];
  /** Config of every stored version, ascending — used to build analytics step order and options. */
  allConfigs(): { version: number; config: FunnelConfig }[];
  hasVersions(): boolean;
}

export function createVersionsService(db: Db, repo: VersionsRepo = createVersionsRepo(db)): VersionsService {
  // Configs are immutable once uploaded, so a plain map is enough; it is only ever filled.
  const cache = new Map<number, FunnelConfig>();

  const requireFunnelId = (): string => {
    const funnel = repo.getFunnel();
    if (!funnel) throw new HttpError(404, 'funnel_not_found', 'No funnel has been uploaded yet');
    return funnel.funnel_id;
  };

  const service: VersionsService = {
    upload(raw) {
      const parsed = safeParseFunnelConfig(raw);
      if (!parsed.ok) {
        throw new HttpError(400, 'invalid_config', 'The uploaded config is not a valid funnel config', parsed.issues);
      }
      const config = parsed.config;
      const funnel = repo.getFunnel();
      if (funnel && funnel.funnel_id !== config.funnelId) {
        throw new HttpError(
          409,
          'funnel_mismatch',
          `This deployment serves funnel "${funnel.funnel_id}"; the config declares "${config.funnelId}"`,
        );
      }
      if (!funnel) repo.createFunnel(config.funnelId);
      if (repo.getVersion(config.funnelId, config.version)) {
        throw new HttpError(409, 'version_exists', `Version ${config.version} already exists`);
      }
      repo.insertVersion({
        funnel_id: config.funnelId,
        version: config.version,
        // Stored as uploaded: the file's `status` is ignored, the database owns the status.
        config_json: JSON.stringify(raw),
        created_at: new Date().toISOString(),
        published_at: null,
      });
      cache.set(config.version, config);
      return { version: config.version };
    },

    publish(version) {
      const funnelId = requireFunnelId();
      const row = repo.getVersion(funnelId, version);
      if (!row) throw new HttpError(404, 'version_not_found', `Version ${version} does not exist`);
      const previous = repo.getFunnel()?.active_version ?? null;
      if (previous === version) throw new HttpError(409, 'already_active', `Version ${version} is already active`);
      const at = new Date().toISOString();
      repo.setActiveVersion(funnelId, version);
      repo.markPublished(funnelId, version, at);
      repo.insertHistory({ funnel_id: funnelId, action: 'publish', from_version: previous, to_version: version, at });
      return { activeVersion: version, fromVersion: previous };
    },

    rollback() {
      const funnelId = requireFunnelId();
      const last = repo.latestHistory(funnelId);
      const target = last?.from_version ?? null;
      // The target is the `from_version` of the last transition, so a rollback after a rollback
      // re-activates the version we rolled back from (1 → 3 → 1 → 3 …). Intentional: the button
      // always undoes the previous transition rather than walking a stack.
      if (target === null) throw new HttpError(409, 'nothing_to_rollback', 'There is no previous version to roll back to');
      if (!repo.getVersion(funnelId, target)) {
        throw new HttpError(409, 'nothing_to_rollback', `Version ${target} is no longer available`);
      }
      const current = repo.getFunnel()?.active_version ?? null;
      if (current === target) throw new HttpError(409, 'already_active', `Version ${target} is already active`);
      const at = new Date().toISOString();
      repo.setActiveVersion(funnelId, target);
      repo.insertHistory({ funnel_id: funnelId, action: 'rollback', from_version: current, to_version: target, at });
      return { activeVersion: target, fromVersion: current };
    },

    list() {
      const funnel = repo.getFunnel();
      if (!funnel) return { funnelId: null, activeVersion: null, versions: [] };
      const sessions = repo.countSessionsByVersion(funnel.funnel_id);
      const versions: VersionSummary[] = repo.listVersions(funnel.funnel_id).map((row) => {
        const config = service.getConfig(row.version);
        const status: VersionStatus =
          funnel.active_version === row.version ? 'active' : row.published_at !== null ? 'published' : 'draft';
        return {
          version: row.version,
          title: config?.title ?? `Version ${row.version}`,
          releaseNote: config?.releaseNote ?? null,
          status,
          createdAt: row.created_at,
          publishedAt: row.published_at,
          sessions: sessions.get(row.version) ?? 0,
        };
      });
      return { funnelId: funnel.funnel_id, activeVersion: funnel.active_version, versions };
    },

    history() {
      const funnel = repo.getFunnel();
      if (!funnel) return { history: [] };
      return {
        history: repo.listHistory(funnel.funnel_id).map((row) => ({
          id: row.id,
          action: row.action,
          fromVersion: row.from_version,
          toVersion: row.to_version,
          at: row.at,
        })),
      };
    },

    getConfig(version) {
      const cached = cache.get(version);
      if (cached) return cached;
      const funnel = repo.getFunnel();
      if (!funnel) return null;
      const row = repo.getVersion(funnel.funnel_id, version);
      if (!row) return null;
      const parsed = safeParseFunnelConfig(JSON.parse(row.config_json));
      if (!parsed.ok) return null;
      cache.set(version, parsed.config);
      return parsed.config;
    },

    getActive() {
      const active = repo.getFunnel()?.active_version ?? null;
      if (active === null) return null;
      const config = service.getConfig(active);
      return config ? { version: active, config } : null;
    },

    activeVersion: () => repo.getFunnel()?.active_version ?? null,
    funnelId: () => repo.getFunnel()?.funnel_id ?? null,

    storedVersions() {
      const funnel = repo.getFunnel();
      return funnel ? repo.listVersions(funnel.funnel_id).map((r) => r.version) : [];
    },

    allConfigs() {
      const out: { version: number; config: FunnelConfig }[] = [];
      for (const version of service.storedVersions()) {
        const config = service.getConfig(version);
        if (config) out.push({ version, config });
      }
      return out;
    },

    hasVersions: () => service.storedVersions().length > 0,
  };

  return service;
}
