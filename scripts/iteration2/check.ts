// The assignment's second iteration as one reproducible procedure: upload and publish v3, prove
// that an old v1 session keeps working and that new sessions get v3, roll back, prove that nothing
// was lost. The CLI is scripts/iteration2-check.ts; a fresh demo boot runs it in-process too.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerKey,
  answerKind,
  computeResult,
  nextStepId,
  resolveCurrentStep,
  resolveVariant,
  validateAnswer,
} from '../../shared/engine';
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
} from '../../shared/api';
import type { Answers, FunnelConfig, ResolvedFunnel, ResultDef, Step } from '../../shared/types';
import { generateTraffic, pickAnswer, stepViewedProperties } from '../traffic/generator';
import { createRng, type Rng } from '../traffic/random';
import type { HttpMethod, Transport } from '../traffic/transport';

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

/**
 * What the safety net found after a failure once the publish request had gone out:
 * `rolled_back` — v3 was active and it rolled back to v1; `v1_active` — v1 was already active;
 * `unresolved` — v3 may still be active (the rollback failed, or --keep-v3).
 */
export type Iteration2Recovery = 'rolled_back' | 'v1_active' | 'unresolved';

export interface Iteration2Result {
  ok: boolean;
  checks: Iteration2Check[];
  /** S1…S4 → session id */
  sessions: Record<string, string>;
  /** Set only when a check failed (or the run threw) after the publish was attempted */
  recovery?: Iteration2Recovery;
}

const OLD_VERSION = 1;
const NEW_VERSION = 3;
/** Every QA session is an override with this campaign, so the dashboard can filter it out. */
const QA_QUERY = { utm_source: 'qa', utm_medium: 'manual', utm_campaign: 'iteration2_check' } as const;
/** Sessions this run creates on v3 besides the generator's: S2 and S3. */
const QA_SESSIONS_ON_V3 = 2;

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

  /** Shows and answers `count` steps, leaving the session mid-funnel. */
  async walkSteps(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      this.view();
      await this.advance();
    }
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

  /** Sends the queued events as one batch, requires every one of them to be accepted, returns their names. */
  async flushAccepted(): Promise<string[]> {
    const events = this.pending;
    this.pending = [];
    const { body } = await this.call<IngestResponse>('POST', '/api/events', { events }, [200]);
    const refused = body.results.filter((r) => r.status !== 'accepted');
    assert(
      refused.length === 0,
      `${refused.length} of ${events.length} events not accepted: ${refused.map((r) => `${r.status}${r.reason ? ` ${r.reason}` : ''}`).join(', ')}`,
    );
    return events.map((e) => e.name);
  }
}

const short = (id: string) => id.slice(0, 8);
const counts = (t: Pick<Totals, 'started' | 'reachedResult' | 'ctaClicked'>) => `${t.started}/${t.reachedResult}/${t.ctaClicked}`;
const transition = (h: HistoryEntry | undefined) => (h ? `${h.action} ${h.fromVersion ?? '–'}→${h.toVersion}` : 'nothing');
/** HH:MM:SS in UTC, so a log pasted into the README reads the same everywhere. */
const clock = (at: Date) => at.toISOString().slice(11, 19);

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch() reports network failures as "fetch failed" with the real reason in `cause`.
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : '';
  return err instanceof CheckFailure ? err.message : `${err.name}: ${err.message}${cause}`;
}

/**
 * Runs the checks in order and logs each as it completes. A failed check before the publish stops
 * the run (nothing has been changed yet, or the proof would be incomplete); after the publish
 * every check runs, so the rollback still happens when a verification fails. If anything failed
 * once the publish request went out, a safety net makes sure v1 is active again (unless keepV3).
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
  let recovery: Iteration2Recovery | undefined;

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
    return { ok: failed.length === 0, checks, sessions, ...(recovery ? { recovery } : {}) };
  };

  log(`Iteration 2: upload v${NEW_VERSION}, publish, verify, roll back to v${OLD_VERSION} (times are UTC)`);

  // 1. Only from a clean v1 state: the rollback at the end must land on v1 again. The analytics
  // baseline lets check 10 count this run's sessions rather than whatever earlier runs left.
  let baseline: { v1: number; v3: number } | undefined;
  const ready = await check('precondition', async () => {
    const { body } = await call<VersionsResponse>('GET', '/api/admin/versions', undefined, [200]);
    const stored = body.versions.map((v) => `v${v.version} ${v.status}`).join(', ') || 'none';
    if (body.activeVersion === NEW_VERSION) {
      throw new CheckFailure(`v3 is already active: roll back first (Rollback on /admin or POST /api/admin/rollback), then rerun`);
    }
    assert(body.activeVersion === OLD_VERSION, `expected v1 to be active, found ${body.activeVersion === null ? 'none' : `v${body.activeVersion}`} (stored: ${stored})`);
    const { byVersion } = await analytics();
    baseline = { v1: byVersion[String(OLD_VERSION)]?.started ?? 0, v3: byVersion[String(NEW_VERSION)]?.started ?? 0 };
    return `v1 is active (stored: ${stored}); analytics baseline v1 ${baseline.v1}, v3 ${baseline.v3} sessions started`;
  });
  if (!ready) return finish();

  // 2. A user who starts on v1 before the release and is halfway through when it happens.
  let s1: Walker | undefined;
  const s1Started = await check('old session starts on v1', async () => {
    const { session, config } = await start('S1', 'A');
    assert(session.version === OLD_VERSION && config.version === OLD_VERSION, `S1 got v${session.version}, expected v1`);
    assert(session.variant === 'A', `S1 got variant ${session.variant}, expected the A override`);
    s1 = new Walker(call, session, config, BASE_ANSWERS, fallback);
    await s1.walkSteps(2);
    const events = await s1.flushAccepted();
    return `S1 ${short(session.id)} on v1/A: ${s1.path.join(' → ')} answered, state saved on ${s1.currentId}; ${events.length} events accepted`;
  });
  if (!s1Started) return finish();

  // 3–4. The release itself: no deploy, no schema change, only the API.
  const uploaded = await check('v3 uploaded', async () => {
    const raw = JSON.parse(readFileSync(join(configsDir, 'funnel-v3.json'), 'utf8')) as { title?: unknown; releaseNote?: unknown };
    const res = await call<UploadVersionResponse & { error?: { code: string } }>('POST', '/api/admin/versions', raw, [201, 409]);
    if (res.status === 201) {
      assert(res.body.version === NEW_VERSION, `upload stored version ${res.body.version}, expected 3`);
      return 'POST /api/admin/versions → 201 { version: 3 }';
    }
    assert(res.body.error?.code === 'version_exists', `POST /api/admin/versions → 409 ${describeBody(res.body)}`);
    // A v3 uploaded earlier is published again only if it is the release in the file.
    const { body } = await call<VersionsResponse>('GET', '/api/admin/versions', undefined, [200]);
    const stored = body.versions.find((v) => v.version === NEW_VERSION);
    assert(stored, 'POST /api/admin/versions → 409 version_exists, but GET /api/admin/versions does not list v3');
    const file = { title: raw.title, releaseNote: raw.releaseNote ?? null };
    assert(
      stored.title === file.title && stored.releaseNote === file.releaseNote,
      `the stored v3 is not configs/funnel-v3.json: stored title ${JSON.stringify(stored.title)} / release note ` +
        `${JSON.stringify(stored.releaseNote)}, the file has ${JSON.stringify(file.title)} / ${JSON.stringify(file.releaseNote)}; ` +
        'not publishing it (compare the stored v3 in /admin with the file)',
    );
    return 'v3 is already stored from an earlier run (409 version_exists) and matches configs/funnel-v3.json (title, release note); publishing it again';
  });
  if (!uploaded) return finish();

  /** Checks 5–14, run once the publish succeeded. */
  const verifyAndRollBack = async (): Promise<void> => {
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
      return `GET S1 → config v1; resumed on ${resumedOn} with ${stored} stored answer(s), finished to result ${result.id} (a v1 result); ${events.length} events accepted`;
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
        `recommendation_expanded among ${events.length} events accepted`
      );
    });

    // 8. Variant A of v3 keeps the step B dropped. S3 stops mid-funnel: it is the user who is
    // still answering when the rollback happens (check 12).
    let s3: Walker | undefined;
    await check('v3 variant A keeps tool_count', async () => {
      const { session, config } = await start('S3', 'A');
      assert(session.version === NEW_VERSION && config.version === NEW_VERSION, `S3 got v${session.version}, expected v3`);
      assert(session.variant === 'A', `S3 got variant ${session.variant}, expected the A override`);
      const walk = new Walker(call, session, config, BASE_ANSWERS, fallback);
      const sequence = walk.resolved.steps.map((s) => s.id);
      assert(sequence.includes('tool_count') && sequence.includes('meeting_hours'), `v3/A sequence: ${sequence.join(', ')}`);
      await walk.walkSteps(2);
      const events = await walk.flushAccepted();
      s3 = walk;
      return (
        `S3 ${short(session.id)} on v3/A: ${sequence.length} steps including tool_count and meeting_hours; ` +
        `${walk.path.join(' → ')} answered, left mid-funnel on ${walk.currentId}; ${events.length} events accepted`
      );
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

    // 10. Both versions side by side, before anything is rolled back. On a rerun both keys exist
    // from earlier runs, so only growth by at least this run's sessions proves they were counted.
    let v3Started: number | undefined;
    let v1Started: number | undefined;
    await check('analytics sees both versions', async () => {
      assert(baseline, 'no analytics baseline from the precondition');
      const { byVersion } = await analytics();
      const v1 = byVersion[String(OLD_VERSION)];
      const v3 = byVersion[String(NEW_VERSION)];
      assert(v1 && v3, `byVersion has ${Object.keys(byVersion).join(', ') || 'no versions'}, expected 1 and 3`);
      v1Started = v1.started;
      v3Started = v3.started;
      const createdOnV3 = QA_SESSIONS_ON_V3 + traffic;
      const v1Growth = v1.started - baseline.v1;
      const v3Growth = v3.started - baseline.v3;
      assert(
        v3Growth >= createdOnV3,
        `v3 started ${baseline.v3} → ${v3.started} (+${v3Growth}) since the precondition, expected at least +${createdOnV3} ` +
          `for S2, S3${traffic > 0 ? ` and ${traffic} generated sessions` : ''}`,
      );
      assert(v1Growth >= 1, `v1 started ${baseline.v1} → ${v1.started} (+${v1Growth}) since the precondition, expected at least +1 for S1`);
      return (
        `byVersion v1 ${counts(v1)}, v3 ${counts(v3)} (started/result/cta); since the precondition v1 +${v1Growth}, ` +
        `v3 +${v3Growth} (this run: S2, S3${traffic > 0 ? ` and ${traffic} generated` : ''})`
      );
    });

    if (opts.keepV3) {
      log('  stopping before the rollback (--keep-v3): v3 stays active');
      return;
    }

    // 11. The rollback: one API call.
    await check('rollback', async () => {
      const { body } = await call<ActivationResponse>('POST', '/api/admin/rollback', undefined, [200]);
      assert(body.activeVersion === OLD_VERSION && body.fromVersion === NEW_VERSION, `rollback returned ${JSON.stringify(body)}`);
      return 'POST /api/admin/rollback → { activeVersion: 1, fromVersion: 3 }';
    });

    // 12. v3 users keep v3 after the rollback: S2 (finished) keeps its v3-only answers and events,
    // S3 (mid-funnel) takes its next step on v3.
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
      const s2 = new Walker(call, session, config, COMPLIANCE_ANSWERS, fallback);
      s2.emit('recommendation_expanded', { result_id: session.resultId, action: 'expand_recommendation', source: 'cta' });
      await s2.flushAccepted();

      const mid = await load('S3');
      assert(s3, 'S3 did not get mid-funnel before the rollback (see the failed check above)');
      assert(mid.config.version === NEW_VERSION && mid.session.version === NEW_VERSION, `GET S3 returned config v${mid.config.version}, expected v3`);
      const walk = new Walker(call, mid.session, mid.config, BASE_ANSWERS, fallback);
      assert(walk.currentId === s3.currentId, `S3 resumed on ${walk.currentId}, expected ${s3.currentId}`);
      const resumedOn = walk.step();
      const key = answerKey(resumedOn);
      assert(key !== null, `S3 resumed on ${resumedOn.id}, which takes no answer`);
      await walk.walkSteps(1);
      const names = await walk.flushAccepted();
      assert(names.includes('step_viewed') && names.includes('answer_submitted'), `S3 sent ${names.join(', ')}`);
      const after = (await load('S3')).session;
      assert(
        after.currentStepId === walk.currentId && after.answers[key] !== undefined,
        `after the step S3 is stored on ${after.currentStepId ?? 'nothing'}${after.answers[key] === undefined ? ` without ${key}` : ''}, expected ${walk.currentId}`,
      );
      return (
        'S2 (finished): GET → config v3; PUT state with v3-only answers (security_constraints, meeting_hours) → 200; ' +
        `recommendation_expanded still accepted. S3 (mid-funnel): GET → config v3; answered ${resumedOn.id} → PUT state 200, ` +
        `now on ${after.currentStepId}; ${names.join(', ')} accepted`
      );
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
  };

  /** The log sink must not stop the safety net. */
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // ignored: leaving v1 active matters more than the line
    }
  };
  /** Best effort: leave v1 active. Rolls back only while v3 is active, so it never undoes a state it did not create. */
  const recover = async (): Promise<Iteration2Recovery> => {
    const unresolved = (reason: string): Iteration2Recovery => {
      say(`⚠ v3 may still be active — roll back in /admin (${reason})`);
      return 'unresolved';
    };
    if (opts.keepV3) return unresolved('--keep-v3: no automatic rollback');
    try {
      const { body } = await call<VersionsResponse>('GET', '/api/admin/versions', undefined, [200]);
      if (body.activeVersion === OLD_VERSION) {
        say('  v1 is active after the failure (GET /api/admin/versions); nothing to roll back');
        return 'v1_active';
      }
      if (body.activeVersion !== NEW_VERSION) return unresolved(`the active version is v${body.activeVersion ?? 'none'}, left as is`);
      const { body: rolled } = await call<ActivationResponse>('POST', '/api/admin/rollback', undefined, [200]);
      if (rolled.activeVersion !== OLD_VERSION) return unresolved(`the rollback returned ${JSON.stringify(rolled)}`);
      say('⚠ rolled back to v1 after a failure');
      return 'rolled_back';
    } catch (err) {
      return unresolved(`the automatic rollback failed: ${errorMessage(err)}`);
    }
  };

  // From the moment the publish request goes out the server may be on v3, even if the response is
  // lost or misread, so a failed check or a throw from here on runs the safety net.
  let publishAttempted = false;
  let completed = false;
  try {
    const published = await check('v3 published', async () => {
      publishAttempted = true;
      const { body } = await call<ActivationResponse>('POST', `/api/admin/versions/${NEW_VERSION}/publish`, undefined, [200]);
      assert(body.activeVersion === NEW_VERSION && body.fromVersion === OLD_VERSION, `publish returned ${JSON.stringify(body)}`);
      return 'POST /api/admin/versions/3/publish → { activeVersion: 3, fromVersion: 1 }';
    });
    if (published) await verifyAndRollBack();
    completed = true;
  } finally {
    if (publishAttempted && (!completed || checks.some((c) => !c.ok))) recovery = await recover();
  }

  return finish();
}
