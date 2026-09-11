import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface SeedOptions {
  /** Directory that holds funnel-v1.json */
  configsDir: string;
  /** Synthetic traffic, run once while the database has no sessions (wired by the generator). */
  runTraffic?: (app: FastifyInstance) => Promise<void>;
}

/**
 * Makes a fresh database usable: publishes v1 when no version is stored, then optionally runs
 * the traffic generator when there are no sessions yet. Safe to call on every boot. Goes through
 * the services directly, so it works with ADMIN_TOKEN set.
 */
export async function ensureSeed(app: FastifyInstance, opts: SeedOptions): Promise<void> {
  const { versions } = app.ctx.services;

  if (!versions.hasVersions()) {
    const raw: unknown = JSON.parse(readFileSync(join(opts.configsDir, 'funnel-v1.json'), 'utf8'));
    const { version } = versions.upload(raw);
    versions.publish(version);
    app.log.info({ version }, 'seeded and published the initial funnel version');
  }

  if (opts.runTraffic) {
    const sessionCount = versions.list().versions.reduce((sum, v) => sum + v.sessions, 0);
    if (sessionCount === 0) await opts.runTraffic(app);
  }
}
