import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { errorMessage, runIteration2Check, type Iteration2Recovery, type Iteration2Result } from '../scripts/iteration2/check';
import { generateTraffic } from '../scripts/traffic/generator';
import { injectTransport } from '../scripts/traffic/transport';

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

export interface BootDemoOptions {
  /** Directory that holds funnel-v1.json and funnel-v3.json */
  configsDir: string;
  /** Generator sessions on v1 before the release (default 120, seed 42) */
  v1Sessions?: number;
  /** Generator sessions on v3 inside the iteration-2 scenario (default 60) */
  v3Sessions?: number;
}

export interface BootDemoOutcome {
  /** false when the database already had sessions (nothing was touched) or seeding itself failed */
  ran: boolean;
  ok: boolean;
  /** The one line logged about the demo */
  summary: string;
}

const RECOVERY_NOTE: Record<Iteration2Recovery, string> = {
  rolled_back: 'rolled back to v1 after the failure',
  v1_active: 'v1 is active',
  unresolved: 'v3 may still be active — roll back in /admin',
};

function describeScenario(result: Iteration2Result): string {
  const total = result.checks.length;
  if (result.ok) return `boot demo: iteration-2 scenario OK — ${total}/${total}`;
  const failed = result.checks.filter((c) => !c.ok);
  const recovery = result.recovery ? `; ${RECOVERY_NOTE[result.recovery]}` : '';
  return `boot demo: iteration-2 scenario FAILED — ${failed.length} of ${total} checks failed: ${failed.map((c) => `${c.step} (${c.detail})`).join('; ')}${recovery}`;
}

/**
 * SEED_ON_BOOT=1: the free host's disk is recreated on every deploy, restart or spin-down, so a
 * database without sessions gets the whole demo in-process — v1 traffic, then the iteration-2
 * scenario (v3 published, v3 traffic, rolled back) — and graders see both versions, the
 * publish/rollback history and v1 active. Never throws: the server keeps serving regardless.
 */
export async function runBootDemo(app: FastifyInstance, opts: BootDemoOptions): Promise<BootDemoOutcome> {
  let ran = false;
  let outcome: BootDemoOutcome;
  try {
    const transport = injectTransport(app, { adminToken: app.ctx.adminToken });
    let scenario: Iteration2Result | undefined;
    await ensureSeed(app, {
      configsDir: opts.configsDir,
      runTraffic: async () => {
        ran = true;
        const summary = await generateTraffic({ transport, sessions: opts.v1Sessions ?? 120, seed: 42, log: (line) => app.log.info(line) });
        if (!summary.ok) app.log.warn('seed traffic: analytics do not match the simulation');
        scenario = await runIteration2Check({
          transport,
          configsDir: opts.configsDir,
          traffic: opts.v3Sessions ?? 60,
          log: (line) => app.log.debug(line),
        });
      },
    });
    if (!ran) outcome = { ran, ok: true, summary: 'boot demo: skipped, the database already has sessions' };
    else if (!scenario) outcome = { ran, ok: false, summary: 'boot demo: FAILED — the iteration-2 scenario did not run' };
    else outcome = { ran, ok: scenario.ok, summary: describeScenario(scenario) };
  } catch (err) {
    outcome = { ran, ok: false, summary: `boot demo: FAILED — ${errorMessage(err)}` };
  }
  if (outcome.ok) app.log.info(outcome.summary);
  else app.log.warn(outcome.summary);
  return outcome;
}
