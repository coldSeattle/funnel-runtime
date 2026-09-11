import { randomUUID } from 'node:crypto';
import {
  allowedEvents,
  answerKey,
  answerKind,
  firstStepId,
  nextStepId,
  prevStepId,
  progress,
  resolveVariant,
  validateAnswer,
  visibleSteps,
} from '../../shared/engine';
import type {
  AnalyticsResponse,
  IncomingEvent,
  IngestResponse,
  ResultResponse,
  SessionResponse,
  UpdateStateResponse,
} from '../../shared/api';
import type { AnswerValue, Answers, ResolvedFunnel, Step } from '../../shared/types';
import type { Rng } from './random';
import { createRng, deriveSeed } from './random';
import type { HttpMethod, Transport } from './transport';

// Simulation knobs. B gets a lower intro drop-off and +10 pp on the CTA so the A/B comparison
// is visible on the dashboard (docs/design.md §10).
const CAMPAIGNS: readonly { campaign: string; channels: readonly (readonly [source: string, medium: string])[] }[] = [
  { campaign: 'spring_launch', channels: [['facebook', 'paid_social']] },
  { campaign: 'retargeting_q3', channels: [['facebook', 'paid_social'], ['google', 'cpc']] },
  { campaign: 'brand_search', channels: [['google', 'cpc']] },
  { campaign: 'partner_webinar', channels: [['newsletter', 'email'], ['tiktok', 'paid_social']] },
];
const OVERRIDE_RATE = 0.08;
const OVERRIDE_PARAM = 'variant';
const OVERRIDE_VARIANTS = ['A', 'B'] as const;
const INTRO_DROP_OFF: Record<string, number> = { A: 0.22, B: 0.15 };
const STEP_DROP_OFF = 0.07;
const CTA_RATE: Record<string, number> = { A: 0.35, B: 0.45 };
const EXPAND_RATE = 0.8;
const BACK_RATE = 0.15;
const BACK_MIN_POSITION = 3;
const REFRESH_RATE = 0.08;
const MAX_BACKDATE_MS = 6 * 24 * 3600 * 1000;
const EVENT_GAP_MS: readonly [number, number] = [3_000, 25_000];
const MAX_BATCHES = 3;
const PROGRESS_EVERY = 25;

export type NoiseKind = 'duplicateInBatch' | 'resendBatch' | 'shuffled' | 'invalidEvent' | 'unknownEvent';
export const NOISE_KINDS: readonly NoiseKind[] = ['duplicateInBatch', 'resendBatch', 'shuffled', 'invalidEvent', 'unknownEvent'];
const NOISE_RATES: Record<NoiseKind, number> = {
  duplicateInBatch: 0.1,
  resendBatch: 0.05,
  shuffled: 0.1,
  invalidEvent: 0.03,
  unknownEvent: 0.02,
};
/**
 * With at least this many sessions, session i < NOISE_KINDS.length is planned noise kind i; a kind
 * that cannot apply there (shuffling needs a batch of two events) moves on to the next session.
 */
const NOISE_COVERAGE_MIN_SESSIONS = 10;

export interface Counts {
  started: number;
  reachedResult: number;
  ctaClicked: number;
}

export interface Outcome extends Counts {
  byVariant: Record<string, Counts>;
}

export interface GenerateOptions {
  transport: Transport;
  sessions: number;
  seed: number;
  log?: (line: string) => void;
}

export interface GeneratorSummary {
  sessions: number;
  eventsSent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  expected: Outcome;
  actualDelta: Outcome;
  ok: boolean;
  /** Sessions in the analytics delta the generator did not create: someone else's traffic during the run */
  concurrentSessions: number;
  /** The mismatch is fully explained by those sessions: no count anywhere fell below the simulation */
  concurrentOnly: boolean;
  /** Sessions per noise kind actually applied (planned shuffles of a session without a two-event batch are not) */
  noise: Record<NoiseKind, number>;
  /** Simulated user behaviour, for the log table */
  behaviour: { overrides: number; backs: number; refreshes: number; droppedOff: number };
}

interface SessionOutcome {
  variant: string;
  reachedResult: boolean;
  ctaClicked: boolean;
  override: boolean;
  back: boolean;
  refresh: boolean;
  noise: NoiseKind[];
}

class ApiError extends Error {}

/**
 * Drives `sessions` synthetic users through the real API on whatever version is active, sends
 * their events with realistic delivery noise and checks the analytics delta against the numbers
 * the simulation expects.
 *
 * Seeding: session i draws from its own stream `deriveSeed(seed, i)`, so its UTM, override,
 * behaviour flags and noise are fixed by the seed. The variant of a non-override session is the
 * server's draw (Math.random), which the seed cannot reach; drop-off and CTA rates depend on it,
 * so result/CTA totals differ between runs with the same seed. The check is always this run's
 * expected numbers against this run's analytics delta.
 */
export async function generateTraffic(opts: GenerateOptions): Promise<GeneratorSummary> {
  const { transport, sessions, seed } = opts;
  const log = opts.log ?? (() => {});
  const call = caller(transport);
  const now = Date.now();

  const before = await call<AnalyticsResponse>('GET', '/api/analytics', undefined, 200);

  const expected: Outcome = { ...zero(), byVariant: {} };
  const noise = Object.fromEntries(NOISE_KINDS.map((k) => [k, 0])) as Record<NoiseKind, number>;
  const behaviour = { overrides: 0, backs: 0, refreshes: 0, droppedOff: 0 };
  const delivery = { eventsSent: 0, accepted: 0, duplicates: 0, rejected: 0 };

  // Forced kinds that could not apply are owed to the following sessions until one takes them.
  const owed = new Set<NoiseKind>();
  for (let i = 0; i < sessions; i++) {
    const forced = new Set(owed);
    const covered = sessions >= NOISE_COVERAGE_MIN_SESSIONS ? NOISE_KINDS[i] : undefined;
    if (covered) forced.add(covered);
    const rng = createRng(deriveSeed(seed, i));
    const outcome = await runSession({ call, rng, now, forcedNoise: forced, delivery });
    for (const kind of forced) {
      if (outcome.noise.includes(kind)) owed.delete(kind);
      else owed.add(kind);
    }

    const bucket = (expected.byVariant[outcome.variant] ??= zero());
    for (const counts of [expected, bucket]) {
      counts.started++;
      if (outcome.reachedResult) counts.reachedResult++;
      if (outcome.ctaClicked) counts.ctaClicked++;
    }
    for (const kind of outcome.noise) noise[kind]++;
    if (outcome.override) behaviour.overrides++;
    if (outcome.back) behaviour.backs++;
    if (outcome.refresh) behaviour.refreshes++;
    if (!outcome.reachedResult) behaviour.droppedOff++;

    if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < sessions) {
      log(`  ${i + 1}/${sessions} sessions, ${delivery.eventsSent} events sent`);
    }
  }

  const after = await call<AnalyticsResponse>('GET', '/api/analytics', undefined, 200);
  const actualDelta = diff(after, before, Object.keys(expected.byVariant));
  const ok = sameOutcome(expected, actualDelta);
  const concurrentSessions = Math.max(0, actualDelta.started - expected.started);
  const concurrentOnly = !ok && explainedByConcurrentTraffic(expected, actualDelta);

  const summary: GeneratorSummary = {
    sessions,
    ...delivery,
    expected,
    actualDelta,
    ok,
    concurrentSessions,
    concurrentOnly,
    noise,
    behaviour,
  };
  for (const line of formatSummary(summary, seed)) log(line);
  return summary;
}

interface SessionContext {
  call: ReturnType<typeof caller>;
  rng: Rng;
  now: number;
  forcedNoise: ReadonlySet<NoiseKind>;
  delivery: { eventsSent: number; accepted: number; duplicates: number; rejected: number };
}

async function runSession({ call, rng, now, forcedNoise, delivery }: SessionContext): Promise<SessionOutcome> {
  const [source, medium, campaign] = pickUtm(rng);
  const query: Record<string, string> = { utm_source: source, utm_medium: medium, utm_campaign: campaign };
  const override = rng.chance(OVERRIDE_RATE);
  if (override) query[OVERRIDE_PARAM] = rng.pick(OVERRIDE_VARIANTS);

  // Behaviour and noise are drawn up front so the draw count does not depend on the path taken.
  const wantsBack = rng.chance(BACK_RATE);
  const wantsRefresh = rng.chance(REFRESH_RATE);
  const refreshAtPosition = rng.int(0, 3);
  const plannedNoise = NOISE_KINDS.filter((kind) => rng.chance(NOISE_RATES[kind]) || forcedNoise.has(kind));

  let clock = now - rng.int(0, MAX_BACKDATE_MS);
  const created = await call<SessionResponse>('POST', '/api/sessions', { query, clientTimestamp: new Date(clock).toISOString() }, 201);
  const { session, config } = created;
  const sessionPath = `/api/sessions/${encodeURIComponent(session.id)}`;
  const resolved = resolveVariant(config, session.variant);
  const allowed = allowedEvents(config);

  const tick = () => {
    clock += rng.int(EVENT_GAP_MS[0], EVENT_GAP_MS[1]);
    return new Date(clock).toISOString();
  };
  const events: IncomingEvent[] = [];
  const emit = (name: string, stepId: string, properties: Record<string, unknown>) => {
    if (!allowed.has(name)) throw new Error(`Event "${name}" is not allowed by version ${config.version}`);
    events.push({ event_id: randomUUID(), session_id: session.id, name, client_timestamp: tick(), step_id: stepId, properties });
  };

  const answers: Answers = {};
  const view = (step: Step) => emit('step_viewed', step.id, stepViewedProperties(resolved, answers, step));
  const saveState = (currentStepId: string) =>
    call<UpdateStateResponse>('PUT', `${sessionPath}/state`, { answers, currentStepId }, 200);

  const introId = firstStepId(resolved, answers);
  const dropChecked = new Set<string>();
  let back = false;
  let refresh = false;
  let reachedResult = false;
  let ctaClicked = false;
  let currentId = introId;

  for (;;) {
    const step = stepOf(resolved, currentId);
    const position = visibleSteps(resolved, answers).findIndex((s) => s.id === step.id);

    if (step.type === 'result') {
      const { result } = await call<ResultResponse>('POST', `${sessionPath}/result`, undefined, 200);
      view(step);
      if (wantsRefresh && !refresh) {
        refresh = true;
        view(step);
      }
      emit('result_viewed', step.id, { result_id: result.id });
      reachedResult = true;
      if (rng.chance(CTA_RATE[session.variant] ?? CTA_RATE.A!)) {
        ctaClicked = true;
        emit('cta_clicked', step.id, { result_id: result.id, action: result.cta.action });
        if (allowed.has('recommendation_expanded') && rng.chance(EXPAND_RATE)) {
          emit('recommendation_expanded', step.id, { result_id: result.id, action: result.cta.action, source: 'cta' });
        }
      }
      break;
    }

    view(step);
    // A refresh re-renders the step: a real repeat view with a fresh event_id.
    if (wantsRefresh && !refresh && position >= refreshAtPosition) {
      refresh = true;
      view(step);
    }

    if (!dropChecked.has(step.id)) {
      dropChecked.add(step.id);
      const dropOff = step.id === introId ? (INTRO_DROP_OFF[session.variant] ?? INTRO_DROP_OFF.A!) : STEP_DROP_OFF;
      if (rng.chance(dropOff)) break;
    }

    if (wantsBack && !back && position >= BACK_MIN_POSITION) {
      const destination = prevStepId(resolved, answers, step.id);
      if (destination !== null) {
        back = true;
        emit('back_clicked', step.id, { destination_step_id: destination });
        await saveState(destination);
        currentId = destination;
        continue;
      }
    }

    const key = answerKey(step);
    if (key !== null) {
      // Coming back to an answered step re-submits the stored answer.
      const checked = validateAnswer(step, answers[key] ?? pickAnswer(step, rng));
      if (!checked.ok || checked.value === undefined) {
        throw new Error(`Generated an invalid answer for ${step.id}: ${checked.ok ? 'empty' : checked.message}`);
      }
      answers[key] = checked.value;
      emit('answer_submitted', step.id, { answer_kind: answerKind(step) });
    }
    const next = nextStepId(resolved, answers, step.id);
    if (next === null) throw new Error(`Step ${step.id} has no next step in variant ${session.variant}`);
    emit('step_completed', step.id, { next_step_id: next });
    await saveState(next);
    currentId = next;
  }

  const noise = await deliver({ call, rng, delivery }, events, plannedNoise, session.id, tick);
  return { variant: session.variant, reachedResult, ctaClicked, override, back, refresh, noise };
}

/**
 * Splits a session's events into 1–3 chronological batches and posts them with the session's
 * planned noise: a shuffled batch, in-batch duplicates, a broken or unknown event, a resent batch.
 * Returns the kinds actually applied; shuffling needs a batch with at least two events.
 */
async function deliver(
  { call, rng, delivery }: Pick<SessionContext, 'call' | 'rng' | 'delivery'>,
  events: IncomingEvent[],
  planned: NoiseKind[],
  sessionId: string,
  tick: () => string,
): Promise<NoiseKind[]> {
  const has = (kind: NoiseKind) => planned.includes(kind);
  const applied = new Set<NoiseKind>();
  const batches = splitIntoBatches(events, rng);

  // Shuffled first, while every event in the batch is a distinct real one: the new order then
  // reaches the events table as out-of-order arrival instead of only moving a duplicate around.
  if (has('shuffled')) {
    const eligible = batches.flatMap((batch, index) => (batch.length >= 2 ? [index] : []));
    if (eligible.length > 0) {
      const index = rng.pick(eligible);
      batches[index] = reorderBatch(batches[index]!, rng);
      applied.add('shuffled');
    }
  }
  if (has('duplicateInBatch')) {
    const batch = rng.pick(batches);
    const copies = rng.shuffle(batch).slice(0, rng.int(1, Math.min(2, batch.length)));
    batch.push(...copies);
    applied.add('duplicateInBatch');
  }
  const last = batches[batches.length - 1]!;
  if (has('invalidEvent')) {
    // Named like a real conversion so that a wrongly accepted event would show up as a mismatch.
    last.push({ event_id: randomUUID(), session_id: sessionId, name: 'cta_clicked', client_timestamp: 'not-a-date', step_id: null });
    applied.add('invalidEvent');
  }
  if (has('unknownEvent')) {
    last.push({ event_id: randomUUID(), session_id: sessionId, name: 'debug_ping', client_timestamp: tick(), step_id: null });
    applied.add('unknownEvent');
  }
  const resendIndex = has('resendBatch') ? rng.int(0, batches.length - 1) : -1;
  if (resendIndex >= 0) applied.add('resendBatch');

  for (const [index, batch] of batches.entries()) {
    const times = index === resendIndex ? 2 : 1;
    for (let t = 0; t < times; t++) {
      const res = await call<IngestResponse>('POST', '/api/events', { events: batch }, 200);
      delivery.eventsSent += batch.length;
      delivery.accepted += res.accepted;
      delivery.duplicates += res.duplicates;
      delivery.rejected += res.rejected;
    }
  }
  return NOISE_KINDS.filter((kind) => applied.has(kind));
}

/**
 * A shuffled copy that is never in the original order: a shuffle that lands on the original is
 * rotated by one instead. Needs at least two distinct items, which a batch of real events has.
 */
export function reorderBatch<T>(batch: readonly T[], rng: Rng): T[] {
  const shuffled = rng.shuffle(batch);
  if (shuffled.some((item, i) => item !== batch[i])) return shuffled;
  return [...batch.slice(1), ...batch.slice(0, 1)];
}

function splitIntoBatches(events: IncomingEvent[], rng: Rng): IncomingEvent[][] {
  const count = rng.int(1, Math.min(MAX_BATCHES, events.length));
  const cuts = rng
    .shuffle(Array.from({ length: events.length - 1 }, (_, i) => i + 1))
    .slice(0, count - 1)
    .sort((a, b) => a - b);
  const bounds = [0, ...cuts, events.length];
  return bounds.slice(1).map((end, i) => events.slice(bounds[i], end));
}

/**
 * A random valid answer: single-select uniform; multi-select 1–min(maxSelections, 3) distinct
 * options; numbers `min + floor((max - min + 1) * r²)`, skewed towards small values.
 */
export function pickAnswer(step: Step, rng: Rng): AnswerValue {
  const options = (step.input?.options ?? []).map((o) => o.value);
  switch (step.type) {
    case 'single-select':
      return rng.pick(options);
    case 'multi-select': {
      const upper = Math.min(step.validation?.maxSelections ?? options.length, 3, options.length);
      const lower = Math.min(Math.max(step.validation?.minSelections ?? 1, 1), upper);
      return rng.shuffle(options).slice(0, rng.int(lower, upper));
    }
    case 'number': {
      const min = step.input?.min ?? 0;
      const increment = step.input?.step ?? 1;
      const max = step.input?.max ?? min + 100 * increment;
      const r = rng.next();
      const slots = Math.floor((max - min) / increment) + 1;
      return min + Math.floor(slots * r * r) * increment;
    }
    default:
      throw new Error(`Step ${step.id} of type ${step.type} takes no answer`);
  }
}

function pickUtm(rng: Rng): [source: string, medium: string, campaign: string] {
  const { campaign, channels } = rng.pick(CAMPAIGNS);
  const [source, medium] = rng.pick(channels);
  return [source, medium, campaign];
}

function stepOf(resolved: ResolvedFunnel, id: string): Step {
  const step = resolved.steps.find((s) => s.id === id);
  if (!step) throw new Error(`Step ${id} is not in variant ${resolved.variant}`);
  return step;
}

/** step_viewed properties as the web client sends them, for the step about to be shown. */
export function stepViewedProperties(resolved: ResolvedFunnel, answers: Answers, step: Step): Record<string, unknown> {
  const p = progress(resolved, answers, step.id, resolved.config.progress);
  return { step_type: step.type, visible_step_index: p?.index ?? null, visible_step_count: countableSteps(resolved, answers) };
}

/** Same counting rule as progress(): the denominator of "Question 2 of 6". */
function countableSteps(resolved: ResolvedFunnel, answers: Answers): number {
  const settings = resolved.config.progress;
  const steps = settings.countVisibleOnly ? visibleSteps(resolved, answers) : resolved.steps;
  return steps.filter((s) => !settings.excludeTypes.includes(s.type)).length;
}

function caller(transport: Transport) {
  return async <T>(method: HttpMethod, path: string, body: unknown, expectedStatus: number): Promise<T> => {
    const res = await transport.request<T>(method, path, body);
    if (res.status !== expectedStatus) {
      throw new ApiError(`${method} ${path} returned ${res.status}, expected ${expectedStatus}: ${JSON.stringify(res.body)}`);
    }
    return res.body;
  };
}

const zero = (): Counts => ({ started: 0, reachedResult: 0, ctaClicked: 0 });

function pickCounts(totals: Counts | undefined): Counts {
  return totals ? { started: totals.started, reachedResult: totals.reachedResult, ctaClicked: totals.ctaClicked } : zero();
}

function subtract(a: Counts, b: Counts): Counts {
  return { started: a.started - b.started, reachedResult: a.reachedResult - b.reachedResult, ctaClicked: a.ctaClicked - b.ctaClicked };
}

function sameCounts(a: Counts, b: Counts): boolean {
  return a.started === b.started && a.reachedResult === b.reachedResult && a.ctaClicked === b.ctaClicked;
}

/** after − before, per total and per variant; variants that did not move are left out unless expected. */
function diff(after: AnalyticsResponse, before: AnalyticsResponse, expectedVariants: string[]): Outcome {
  const byVariant: Record<string, Counts> = {};
  const variants = new Set([...expectedVariants, ...Object.keys(after.byVariant), ...Object.keys(before.byVariant)]);
  for (const variant of [...variants].sort()) {
    const delta = subtract(pickCounts(after.byVariant[variant]), pickCounts(before.byVariant[variant]));
    if (expectedVariants.includes(variant) || !sameCounts(delta, zero())) byVariant[variant] = delta;
  }
  return { ...subtract(pickCounts(after.totals), pickCounts(before.totals)), byVariant };
}

function sameOutcome(expected: Outcome, actual: Outcome): boolean {
  if (!sameCounts(expected, actual)) return false;
  const variants = new Set([...Object.keys(expected.byVariant), ...Object.keys(actual.byVariant)]);
  return [...variants].every((v) => sameCounts(pickCounts(expected.byVariant[v]), pickCounts(actual.byVariant[v])));
}

/**
 * Whether other visitors alone can account for the difference: they only ever add sessions, results
 * and clicks, so started must have grown and no count, in total or in any variant, may be below the
 * simulation. A single count below it is a real loss, whatever else moved.
 */
export function explainedByConcurrentTraffic(expected: Outcome, actual: Outcome): boolean {
  if (actual.started <= expected.started) return false;
  const atLeast = (a: Counts, e: Counts) =>
    a.started >= e.started && a.reachedResult >= e.reachedResult && a.ctaClicked >= e.ctaClicked;
  if (!atLeast(actual, expected)) return false;
  const variants = new Set([...Object.keys(expected.byVariant), ...Object.keys(actual.byVariant)]);
  return [...variants].every((v) => atLeast(pickCounts(actual.byVariant[v]), pickCounts(expected.byVariant[v])));
}

function verdict(s: GeneratorSummary): string {
  if (s.ok) return 'Result: OK, analytics match the simulation';
  // Sessions the generator never created can only be someone else's; a bare mismatch would read
  // like an analytics bug. Blamed only when they explain the whole difference.
  if (s.concurrentOnly) {
    return `Result: MISMATCH — concurrent traffic: +${s.concurrentSessions} sessions not created by the generator`;
  }
  const extra =
    s.concurrentSessions > 0
      ? ` (also +${s.concurrentSessions} sessions not created by the generator, which cannot explain counts below the simulation)`
      : '';
  return `Result: MISMATCH, analytics differ from the simulation${extra}`;
}

function formatSummary(s: GeneratorSummary, seed: number): string[] {
  const triple = (c: Counts | undefined) => {
    const { started, reachedResult, ctaClicked } = pickCounts(c);
    return `${started} / ${reachedResult} / ${ctaClicked}`;
  };
  const variants = [...new Set([...Object.keys(s.expected.byVariant), ...Object.keys(s.actualDelta.byVariant)])].sort();
  const rows: [string, Counts | undefined, Counts | undefined][] = [
    ['total', s.expected, s.actualDelta],
    ...variants.map((v): [string, Counts | undefined, Counts | undefined] => [
      `variant ${v}`,
      s.expected.byVariant[v],
      s.actualDelta.byVariant[v],
    ]),
  ];
  const row = (label: string, expected: string, actual: string, verdict: string) =>
    `  ${label.padEnd(12)}${expected.padEnd(18)}${actual.padEnd(18)}${verdict}`;

  return [
    `Traffic generator: ${s.sessions} sessions, seed ${seed}`,
    `  events sent  ${s.eventsSent} (accepted ${s.accepted}, duplicates ${s.duplicates}, rejected ${s.rejected})`,
    `  noise        ${NOISE_KINDS.map((k) => `${k} ${s.noise[k]}`).join(', ')}`,
    `  behaviour    overrides ${s.behaviour.overrides}, back ${s.behaviour.backs}, refresh ${s.behaviour.refreshes}, dropped off ${s.behaviour.droppedOff}`,
    row('', 'expected', 'actual delta', ''),
    row('', 'start/result/cta', 'start/result/cta', ''),
    ...rows.map(([label, expected, actual]) =>
      row(label, triple(expected), triple(actual), sameCounts(pickCounts(expected), pickCounts(actual)) ? 'OK' : 'MISMATCH'),
    ),
    verdict(s),
    '  note: the server draws each variant, so result/cta totals vary between runs with the same seed',
  ];
}
