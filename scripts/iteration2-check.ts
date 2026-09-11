// npm run iteration2 -- [--url https://host] [--traffic 60] [--seed 3] [--keep-v3] [--admin-token T]
// The assignment's second iteration as one reproducible procedure: upload and publish v3, prove
// that an old v1 session keeps working and that new sessions get v3, roll back, prove that nothing
// was lost. Without --url it runs against a fresh in-memory app with v1 published.
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../server/app';
import { ensureSeed } from '../server/seed';
import {
  answerKey,
  answerKind,
  computeResult,
  nextStepId,
  resolveCurrentStep,
  resolveVariant,
  validateAnswer,
} from '../shared/engine';
import type {
  ActivationResponse,
  AnalyticsResponse,
  HistoryEntry,
  HistoryResponse,
  IncomingEvent,
  IngestResponse,
  ResultResponse,
  SessionDto,
  SessionResponse,
  Totals,
  UpdateStateResponse,
  UploadVersionResponse,
  VersionsResponse,
} from '../shared/api';
import type { Answers, FunnelConfig, ResolvedFunnel, ResultDef, Step } from '../shared/types';
import { generateTraffic, pickAnswer, stepViewedProperties } from './traffic/generator';
import { createRng, type Rng } from './traffic/random';
import { httpTransport, injectTransport, type HttpMethod, type Transport } from './traffic/transport';

export interface Iteration2Options {
  transport: Transport;
  /** Directory with funnel-v3.json */
  configsDir: string;
  /** Generator sessions to run on v3 before the rollback (default 0) */
  traffic?: number;
  /** Generator seed (default 3) */
  seed?: number;
  /** Stop before the rollback (default false) */
  keepV3?: boolean;
  log?: (line: string) => void;
  /** Clock for the check timestamps */
  now?: () => Date;
}

export interface Iteration2Check {
  step: string;
  ok: boolean;
  detail: string;
  at: string;
}

export interface Iteration2Result {
  ok: boolean;
  checks: Iteration2Check[];
  /** S1…S4 → session id */
  sessions: Record<string, string>;
}

const OLD_VERSION = 1;
const NEW_VERSION = 3;
/** Every QA session is an override with this campaign, so the dashboard can filter it out. */
const QA_QUERY = { utm_source: 'qa', utm_medium: 'manual', utm_campaign: 'iteration2_check' } as const;

/** Scripted answers by answer key. S1 ends on async_native in v1 (remote + wide timezones). */
const BASE_ANSWERS: Answers = {
  team_size: 12,
  work_mode: 'remote',
  priorities: ['focus', 'speed'],
  timezone_span: 'wide',
  office_days: 2,
  async_maturity: 'medium',
  tool_count: 8,
  meeting_hours: 5,
  security_constraints: 'standard',
};
/** S2 on v3/B: compliance opens security_constraints, strict gives regulated_scale. */
const COMPLIANCE_ANSWERS: Answers = { ...BASE_ANSWERS, priorities: ['compliance', 'focus'], security_constraints: 'strict' };

class CheckFailure extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

type Call = <T>(method: HttpMethod, path: string, body: unknown, expected: readonly number[]) => Promise<{ status: number; body: T }>;

function caller(transport: Transport): Call {
  return async <T>(method: HttpMethod, path: string, body: unknown, expected: readonly number[]) => {
    const res = await transport.request<unknown>(method, path, body);
    if (!expected.includes(res.status)) {
      const hint = res.status === 401 ? ' (pass --admin-token)' : '';
      throw new CheckFailure(`${method} ${path} → ${res.status} ${describeBody(res.body)}${hint}`);
    }
    return { status: res.status, body: res.body as T };
  };
}

function describeBody(body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (error && typeof error.code === 'string') return `${error.code}: ${String(error.message)}`;
  return (JSON.stringify(body) ?? '').slice(0, 200);
}

/**
 * One QA user on one session: renders steps with the shared engine, answers from a script, saves
 * state after every step and sends the same events the web client would.
 */
class Walker {
  readonly resolved: ResolvedFunnel;
  readonly answers: Answers;
  currentId: string;
  /** Step ids shown, in order */
  readonly path: string[] = [];
  private pending: IncomingEvent[] = [];
  private lastTimestamp = 0;

  constructor(
    private readonly call: Call,
    readonly session: SessionDto,
    readonly config: FunnelConfig,
    private readonly script: Answers,
    private readonly fallback: Rng,
  ) {
    this.resolved = resolveVariant(config, session.variant);
    this.answers = { ...session.answers };
    // Resume where the server says the user was, exactly like a refresh.
    this.currentId = resolveCurrentStep(this.resolved, this.answers, session.currentStepId).id;
  }

  private get sessionPath(): string {
    return `/api/sessions/${encodeURIComponent(this.session.id)}`;
  }

  step(): Step {
    const step = this.resolved.steps.find((s) => s.id === this.currentId);
    assert(step, `step ${this.currentId} is not in v${this.config.version}/${this.session.variant}`);
    return step;
  }

  emit(name: string, properties: Record<string, unknown>): void {
    // Strictly increasing client time, so the exit step of the session is never ambiguous.
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    this.pending.push({
      event_id: randomUUID(),
      session_id: this.session.id,
      name,
      client_timestamp: new Date(this.lastTimestamp).toISOString(),
      step_id: this.currentId,
      properties,
    });
  }

  view(): void {
    const step = this.step();
    this.path.push(step.id);
    this.emit('step_viewed', stepViewedProperties(this.resolved, this.answers, step));
  }

  /** Answers the current step (validated by the engine first), saves state and moves on. */
  async advance(): Promise<void> {
    const step = this.step();
    const key = answerKey(step);
    if (key !== null) {
      const checked = validateAnswer(step, this.script[key] ?? pickAnswer(step, this.fallback));
      assert(checked.ok && checked.value !== undefined, `no valid scripted answer for ${step.id}`);
      this.answers[key] = checked.value;
      this.emit('answer_submitted', { answer_kind: answerKind(step) });
    }
    const next = nextStepId(this.resolved, this.answers, step.id);
    assert(next !== null, `${step.id} has no next step in v${this.config.version}/${this.session.variant}`);
    this.emit('step_completed', { next_step_id: next });
    await this.call<UpdateStateResponse>('PUT', `${this.sessionPath}/state`, { answers: this.answers, currentStepId: next }, [200]);
    this.currentId = next;
  }

  /** Shows and answers steps up to the result screen, then lets the server compute the result. */
  async walkToResult(): Promise<ResultDef> {
    for (let guard = 0; guard < 50; guard++) {
      this.view();
      if (this.step().type === 'result') {
        const { body } = await this.call<ResultResponse>('POST', `${this.sessionPath}/result`, undefined, [200]);
        this.emit('result_viewed', { result_id: body.result.id });
        return body.result;
      }
      await this.advance();
    }
    throw new CheckFailure('the walk did not reach the result within 50 steps');
  }

  /** Sends the queued events as one batch and requires every one of them to be accepted. */
  async flushAccepted(): Promise<number> {
    const events = this.pending;
    this.pending = [];
    const { body } = await this.call<IngestResponse>('POST', '/api/events', { events }, [200]);
    const refused = body.results.filter((r) => r.status !== 'accepted');
    assert(
      refused.length === 0,
      `${refused.length} of ${events.length} events not accepted: ${refused.map((r) => `${r.status}${r.reason ? ` ${r.reason}` : ''}`).join(', ')}`,
    );
    return events.length;
  }
}

const short = (id: string) => id.slice(0, 8);
const counts = (t: Pick<Totals, 'started' | 'reachedResult' | 'ctaClicked'>) => `${t.started}/${t.reachedResult}/${t.ctaClicked}`;
const transition = (h: HistoryEntry | undefined) => (h ? `${h.action} ${h.fromVersion ?? '–'}→${h.toVersion}` : 'nothing');
/** HH:MM:SS in UTC, so a log pasted into the README reads the same everywhere. */
const clock = (at: Date) => at.toISOString().slice(11, 19);

function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch() reports network failures as "fetch failed" with the real reason in `cause`.
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return err instanceof CheckFailure ? err.message : `${err.name}: ${err.message}${cause}`;
}

/**
 * Runs the checks in order and logs each as it completes. A failed check before the publish stops
 * the run (nothing has been changed yet, or the proof would be incomplete); after the publish
 * every check runs, so the rollback still happens when a verification fails.
 */
export async function runIteration2Check(opts: Iteration2Options): Promise<Iteration2Result> {
  const { configsDir } = opts;
  const traffic = opts.traffic ?? 0;
  const seed = opts.seed ?? 3;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => new Date());
  const call = caller(opts.transport);
  const fallback = createRng(seed);

  const checks: Iteration2Check[] = [];
  const sessions: Record<string, string> = {};
  const labels: Record<string, string> = {};

  const check = async (step: string, run: () => Promise<string>): Promise<boolean> => {
    let ok = true;
    let detail: string;
    try {
      detail = await run();
    } catch (err) {
      ok = false;
      detail = errorMessage(err);
    }
    const at = now();
    checks.push({ step, ok, detail, at: at.toISOString() });
    log(`${ok ? '✓' : '✗'} ${clock(at)} ${step} — ${detail}`);
    return ok;
  };

  const start = async (name: string, variant: string): Promise<SessionResponse> => {
    const { body } = await call<SessionResponse>(
      'POST',
      '/api/sessions',
      { query: { ...QA_QUERY, variant }, clientTimestamp: new Date().toISOString() },
      [201],
    );
    sessions[name] = body.session.id;
    labels[name] = `v${body.session.version}/${body.session.variant}`;
    return body;
  };
  const load = async (name: string): Promise<SessionResponse> => {
    const id = sessions[name];
    assert(id, `${name} was not created (see the failed check above)`);
    return (await call<SessionResponse>('GET', `/api/sessions/${encodeURIComponent(id)}`, undefined, [200])).body;
  };
  const analytics = async (query = ''): Promise<AnalyticsResponse> =>
    (await call<AnalyticsResponse>('GET', `/api/analytics${query}`, undefined, [200])).body;

  const finish = (): Iteration2Result => {
    const failed = checks.filter((c) => !c.ok);
    const ids = Object.entries(sessions).map(([name, id]) => `${name} ${labels[name]} ${id}`);
    if (ids.length > 0) log(`Sessions: ${ids.join(' · ')}`);
    log(
      failed.length === 0
        ? `Result: OK — ${checks.length}/${checks.length} checks passed`
        : `Result: FAILED — ${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.step).join(', ')}`,
    );
    return { ok: failed.length === 0, checks, sessions };
  };

  log(`Iteration 2: upload v${NEW_VERSION}, publish, verify, roll back to v${OLD_VERSION} (times are UTC)`);

  // 1. Only from a clean v1 state: the rollback at the end must land on v1 again.
  const ready = await check('precondition', async () => {
    const { body } = await call<VersionsResponse>('GET', '/api/admin/versions', undefined, [200]);
    const stored = body.versions.map((v) => `v${v.version} ${v.status}`).join(', ') || 'none';
    if (body.activeVersion === NEW_VERSION) {
      throw new CheckFailure(`v3 is already active: roll back first (Rollback on /admin or POST /api/admin/rollback), then rerun`);
    }
    assert(body.activeVersion === OLD_VERSION, `expected v1 to be active, found ${body.activeVersion === null ? 'none' : `v${body.activeVersion}`} (stored: ${stored})`);
    return `v1 is active (stored: ${stored})`;
  });
  if (!ready) return finish();

  // 2. A user who starts on v1 before the release and is halfway through when it happens.
  let s1: Walker | undefined;
  const s1Started = await check('old session starts on v1', async () => {
    const { session, config } = await start('S1', 'A');
    assert(session.version === OLD_VERSION && config.version === OLD_VERSION, `S1 got v${session.version}, expected v1`);
    assert(session.variant === 'A', `S1 got variant ${session.variant}, expected the A override`);
    s1 = new Walker(call, session, config, BASE_ANSWERS, fallback);
    for (let i = 0; i < 2; i++) {
      s1.view();
      await s1.advance();
    }
    const events = await s1.flushAccepted();
    return `S1 ${short(session.id)} on v1/A: ${s1.path.join(' → ')} answered, state saved on ${s1.currentId}; ${events} events accepted`;
  });
  if (!s1Started) return finish();

  // 3–4. The release itself: no deploy, no schema change, only the API.
  const uploaded = await check('v3 uploaded', async () => {
    const raw: unknown = JSON.parse(readFileSync(join(configsDir, 'funnel-v3.json'), 'utf8'));
    const res = await call<UploadVersionResponse & { error?: { code: string } }>('POST', '/api/admin/versions', raw, [201, 409]);
    if (res.status === 201) {
      assert(res.body.version === NEW_VERSION, `upload stored version ${res.body.version}, expected 3`);
      return 'POST /api/admin/versions → 201 { version: 3 }';
    }
    assert(res.body.error?.code === 'version_exists', `POST /api/admin/versions → 409 ${describeBody(res.body)}`);
    return 'v3 is already stored from an earlier run (409 version_exists); publishing it again';
  });
  if (!uploaded) return finish();

  const published = await check('v3 published', async () => {
    const { body } = await call<ActivationResponse>('POST', `/api/admin/versions/${NEW_VERSION}/publish`, undefined, [200]);
    assert(body.activeVersion === NEW_VERSION && body.fromVersion === OLD_VERSION, `publish returned ${JSON.stringify(body)}`);
    return 'POST /api/admin/versions/3/publish → { activeVersion: 3, fromVersion: 1 }';
  });
  if (!published) return finish();

  // From here on every check runs, so a failed verification still ends in the rollback.

  // 5. The old session resumes from server state on its own version and finishes.
  let s1Result: string | undefined;
  await check('old session continues on v1', async () => {
    const { session, config } = await load('S1');
    assert(config.version === OLD_VERSION && session.version === OLD_VERSION, `GET S1 returned config v${config.version}, expected v1`);
    const walk = new Walker(call, session, config, BASE_ANSWERS, fallback);
    assert(walk.currentId === s1?.currentId, `S1 resumed on ${walk.currentId}, expected ${s1?.currentId}`);
    const resumedOn = walk.currentId;
    const stored = Object.keys(session.answers).length;
    const result = await walk.walkToResult();
    const events = await walk.flushAccepted();
    assert(config.results[result.id] !== undefined, `result ${result.id} is not a v1 result`);
    const expected = computeResult(walk.resolved, walk.answers).id;
    assert(result.id === expected, `the server computed ${result.id}, the v1 rules give ${expected}`);
    s1Result = result.id;
    return `GET S1 → config v1; resumed on ${resumedOn} with ${stored} stored answer(s), finished to result ${result.id} (a v1 result); ${events} events accepted`;
  });

  // 6. The whitelist follows the session's version, not the active one.
  await check('new event is version-scoped', async () => {
    const id = sessions.S1!;
    const event: IncomingEvent = {
      event_id: randomUUID(),
      session_id: id,
      name: 'recommendation_expanded',
      client_timestamp: new Date().toISOString(),
      step_id: 'result',
      properties: { result_id: s1Result ?? null, action: 'expand_recommendation', source: 'cta' },
    };
    const { body } = await call<IngestResponse>('POST', '/api/events', { events: [event] }, [200]);
    const [item] = body.results;
    assert(item?.status === 'rejected' && item.reason === 'unknown_event', `expected rejected: unknown_event, got ${item?.status ?? 'nothing'}${item?.reason ? ` ${item.reason}` : ''}`);
    return 'recommendation_expanded for S1 → rejected: unknown_event (v1 does not allow it)';
  });

  // 7. A new user gets v3; variant B is shorter and the compliance branch opens.
  await check('new session starts on v3 (variant B)', async () => {
    const { session, config } = await start('S2', 'B');
    assert(session.version === NEW_VERSION && config.version === NEW_VERSION, `S2 got v${session.version}, expected v3`);
    assert(session.variant === 'B', `S2 got variant ${session.variant}, expected the B override`);
    const walk = new Walker(call, session, config, COMPLIANCE_ANSWERS, fallback);
    const sequence = walk.resolved.steps.map((s) => s.id);
    assert(!sequence.includes('tool_count'), 'variant B of v3 still has tool_count');
    // The branch is conditional: without compliance the follow-up is skipped.
    const withoutCompliance = nextStepId(walk.resolved, { ...COMPLIANCE_ANSWERS, priorities: ['focus'] }, 'priorities');
    assert(withoutCompliance !== 'security_constraints', 'security_constraints shows up without compliance');

    const result = await walk.walkToResult();
    const afterPriorities = walk.path[walk.path.indexOf('priorities') + 1];
    assert(afterPriorities === 'security_constraints', `after priorities with compliance came ${afterPriorities ?? 'nothing'}, expected security_constraints`);
    assert(result.id === 'regulated_scale', `result ${result.id}, expected regulated_scale`);
    const overrideTitle = config.experiment.variants.B?.resultOverrides?.regulated_scale?.title;
    assert(overrideTitle !== undefined && result.title === overrideTitle, `result title "${result.title}" is not B's override "${overrideTitle}"`);

    walk.emit('cta_clicked', { result_id: result.id, action: result.cta.action });
    walk.emit('recommendation_expanded', { result_id: result.id, action: result.cta.action, source: 'cta' });
    const events = await walk.flushAccepted();
    return (
      `S2 ${short(session.id)} on v3/B, ${sequence.length} steps without tool_count; priorities with compliance → ` +
      `security_constraints (strict) → result regulated_scale "${result.title}"; result_viewed, cta_clicked, ` +
      `recommendation_expanded among ${events} events accepted`
    );
  });

  // 8. Variant A of v3 keeps the step B dropped.
  await check('v3 variant A keeps tool_count', async () => {
    const { session, config } = await start('S3', 'A');
    assert(session.version === NEW_VERSION && config.version === NEW_VERSION, `S3 got v${session.version}, expected v3`);
    const sequence = resolveVariant(config, session.variant).steps.map((s) => s.id);
    assert(sequence.includes('tool_count') && sequence.includes('meeting_hours'), `v3/A sequence: ${sequence.join(', ')}`);
    return `S3 ${short(session.id)} on v3/${session.variant}: ${sequence.length} steps including tool_count and meeting_hours`;
  });

  // 9. Real volume on v3, checked against analytics by the generator itself.
  if (traffic > 0) {
    await check('synthetic v3 traffic', async () => {
      const before = (await analytics(`?version=${NEW_VERSION}`)).totals.started;
      const summary = await generateTraffic({ transport: opts.transport, sessions: traffic, seed, log: (line) => log(`    ${line}`) });
      // Other visitors only add counts, so they are named as the cause only when nothing fell short.
      assert(
        summary.ok,
        summary.concurrentOnly
          ? `analytics moved by ${summary.concurrentSessions} sessions the generator did not create (concurrent traffic)`
          : 'the analytics delta differs from the simulation (table above)' +
              (summary.concurrentSessions > 0
                ? `; the ${summary.concurrentSessions} sessions the generator did not create cannot explain counts below it`
                : ''),
      );
      const onV3 = (await analytics(`?version=${NEW_VERSION}`)).totals.started - before;
      assert(onV3 === traffic, `${onV3} of ${traffic} generated sessions landed on v3`);
      return `${traffic} sessions on v3 (seed ${seed}), ${summary.eventsSent} events with noise; analytics delta ${counts(summary.actualDelta)} start/result/cta matches the simulation`;
    });
  } else {
    log('  synthetic v3 traffic skipped (pass --traffic N to run it)');
  }

  // 10. Both versions side by side, before anything is rolled back.
  let v3Started: number | undefined;
  let v1Started: number | undefined;
  await check('analytics sees both versions', async () => {
    const { byVersion } = await analytics();
    const v1 = byVersion[String(OLD_VERSION)];
    const v3 = byVersion[String(NEW_VERSION)];
    assert(v1 && v3, `byVersion has ${Object.keys(byVersion).join(', ') || 'no versions'}, expected 1 and 3`);
    v1Started = v1.started;
    v3Started = v3.started;
    return `byVersion v1 ${counts(v1)}, v3 ${counts(v3)} (started/result/cta)`;
  });

  if (opts.keepV3) {
    log('  stopping before the rollback (--keep-v3): v3 stays active');
    return finish();
  }

  // 11. The rollback: one API call.
  await check('rollback', async () => {
    const { body } = await call<ActivationResponse>('POST', '/api/admin/rollback', undefined, [200]);
    assert(body.activeVersion === OLD_VERSION && body.fromVersion === NEW_VERSION, `rollback returned ${JSON.stringify(body)}`);
    return 'POST /api/admin/rollback → { activeVersion: 1, fromVersion: 3 }';
  });

  // 12. A v3 user in the middle of it keeps v3: config, v3-only answers and v3-only events.
  await check('v3 session keeps working after rollback', async () => {
    const { session, config } = await load('S2');
    assert(config.version === NEW_VERSION && session.version === NEW_VERSION, `GET S2 returned config v${config.version}, expected v3`);
    const v3Only = ['security_constraints', 'meeting_hours'].filter((key) => key in session.answers);
    assert(v3Only.length === 2, `S2 kept only ${v3Only.join(', ') || 'none'} of its v3-only answers`);
    await call<UpdateStateResponse>(
      'PUT',
      `/api/sessions/${encodeURIComponent(session.id)}/state`,
      { answers: session.answers, currentStepId: session.currentStepId ?? 'result' },
      [200],
    );
    const walk = new Walker(call, session, config, COMPLIANCE_ANSWERS, fallback);
    walk.emit('recommendation_expanded', { result_id: session.resultId, action: 'expand_recommendation', source: 'cta' });
    await walk.flushAccepted();
    return 'GET S2 → config v3; PUT state with v3-only answers (security_constraints, meeting_hours) → 200; recommendation_expanded still accepted';
  });

  // 13. New users are back on v1.
  await check('new sessions return to v1', async () => {
    const { session, config } = await start('S4', 'A');
    assert(session.version === OLD_VERSION && config.version === OLD_VERSION, `S4 got v${session.version}, expected v1`);
    return `S4 ${short(session.id)} → v1`;
  });

  // 14. Nothing was deleted or recounted by the rollback.
  await check('no analytics loss', async () => {
    assert(v3Started !== undefined && v1Started !== undefined, 'no baseline: the analytics check before the rollback failed');
    const { byVersion } = await analytics();
    const v3 = byVersion[String(NEW_VERSION)];
    const v1 = byVersion[String(OLD_VERSION)];
    assert(v3?.started === v3Started, `v3 started ${v3?.started ?? 0} after the rollback, ${v3Started} before`);
    assert(v1 !== undefined && v1.started >= v1Started + 1, `v1 started ${v1?.started ?? 0}, expected at least ${v1Started + 1} with S4`);

    const { history } = (await call<HistoryResponse>('GET', '/api/admin/history', undefined, [200])).body;
    const [publish, rollback] = history.slice(-2);
    assert(
      publish?.action === 'publish' && publish.toVersion === NEW_VERSION && rollback?.action === 'rollback' && rollback.toVersion === OLD_VERSION,
      `history ends with ${transition(publish)}, ${transition(rollback)}; expected publish →3, rollback →1`,
    );
    const { body: versions } = await call<VersionsResponse>('GET', '/api/admin/versions', undefined, [200]);
    const v3Row = versions.versions.find((v) => v.version === NEW_VERSION);
    assert(versions.activeVersion === OLD_VERSION && v3Row?.status === 'published', `v3 is ${v3Row?.status ?? 'gone'}, active v${versions.activeVersion}`);
    return (
      `v3 started ${v3.started} before and after the rollback, v1 ${v1Started} → ${v1.started}; ` +
      `history ends ${transition(publish)}, ${transition(rollback)}; v3 still stored with ${v3Row.sessions} sessions`
    );
  });

  return finish();
}

const USAGE = 'Usage: npm run iteration2 -- [--url https://host] [--traffic 60] [--seed 3] [--keep-v3] [--admin-token T]';

function parseCount(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got "${raw}"\n${USAGE}`);
  return n;
}

async function main(): Promise<Iteration2Result> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      traffic: { type: 'string', default: '0' },
      seed: { type: 'string', default: '3' },
      'keep-v3': { type: 'boolean', default: false },
      'admin-token': { type: 'string' },
    },
  });
  const traffic = parseCount(values.traffic, '--traffic', 0);
  const seed = parseCount(values.seed, '--seed', 0);
  // The env var keeps the token out of shell history and the process list.
  const adminToken = values['admin-token'] || process.env.ADMIN_TOKEN || null;
  const configsDir = fileURLToPath(new URL('../configs', import.meta.url));
  const log = (line: string) => console.log(line);
  const common = { configsDir, traffic, seed, keepV3: values['keep-v3'], log };

  if (values.url) {
    log(`Target: ${values.url}`);
    return runIteration2Check({ ...common, transport: httpTransport(values.url, { adminToken }) });
  }
  log('Target: fresh in-memory app with v1 published (pass --url to check a deployment)');
  const app = buildApp({ adminToken });
  try {
    await ensureSeed(app, { configsDir });
    return await runIteration2Check({ ...common, transport: injectTransport(app, { adminToken }) });
  } finally {
    await app.close();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Importing the module (tests) must not start a run.
if (invokedDirectly()) {
  main().then(
    (result) => {
      process.exitCode = result.ok ? 0 : 1;
    },
    (err: unknown) => {
      console.error(errorMessage(err));
      process.exitCode = 1;
    },
  );
}
