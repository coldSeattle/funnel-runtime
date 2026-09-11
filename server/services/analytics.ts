import type { EventsRepo } from '../repos/events';
import type { SessionsRepo } from '../repos/sessions';
import type { VersionsService } from './versions';
import { aggregate, type StepOrderEntry } from './aggregate';
import { variantKeys } from '../../shared/engine';
import type { FunnelConfig } from '../../shared/types';
import type { AnalyticsFilters, AnalyticsResponse } from '../../shared/api';

export interface AnalyticsService {
  analytics(filters: AnalyticsFilters): AnalyticsResponse;
}

export function createAnalyticsService(
  events: EventsRepo,
  sessions: SessionsRepo,
  versions: VersionsService,
): AnalyticsService {
  return {
    analytics(filters) {
      const configs = versions.allConfigs();
      const selected = filters.version === undefined ? configs : configs.filter((c) => c.version === filters.version);
      const result = aggregate(events.queryEvents(filters), buildStepOrder(selected.map((c) => c.config)));
      return {
        filters,
        options: {
          versions: versions.storedVersions(),
          variants: [...new Set(configs.flatMap((c) => variantKeys(c.config)))].sort(),
          campaigns: sessions.campaigns(),
        },
        ...result,
        steps: resultLast(result.steps),
      };
    },
  };
}

/**
 * Stable: result rows move to the end. Across versions v1's `result` would otherwise sit before
 * the steps v3 added, and steps known only from events are appended after the configured order.
 */
export function resultLast<T extends { type: string | null }>(rows: T[]): T[] {
  return [...rows.filter((r) => r.type !== 'result'), ...rows.filter((r) => r.type === 'result')];
}

/**
 * Per version: the first variant's sequence (A), then steps only the other variants have, in
 * their own order. Several versions are concatenated in ascending order, first occurrence wins.
 */
export function buildStepOrder(configs: FunnelConfig[]): StepOrderEntry[] {
  const order: StepOrderEntry[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    for (const variant of variantKeys(config).sort()) {
      for (const stepId of config.experiment.variants[variant]?.stepSequence ?? []) {
        if (seen.has(stepId)) continue;
        seen.add(stepId);
        order.push({ stepId, type: config.steps[stepId]?.type ?? null });
      }
    }
  }
  return order;
}
