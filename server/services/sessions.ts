import { randomUUID } from 'node:crypto';
import { HttpError } from '../errors';
import type { EventsRepo } from '../repos/events';
import type { SessionRow, SessionsRepo } from '../repos/sessions';
import type { VersionsService } from './versions';
import { answerKey, computeResult as computeResultFromEngine, resolveVariant, validateAnswer } from '../../shared/engine';
import type { Answers, FunnelConfig, ResultDef } from '../../shared/types';
import type {
  AssignmentSource,
  CreateSessionRequest,
  SessionDto,
  SessionResponse,
  UpdateStateResponse,
} from '../../shared/api';

export interface SessionsService {
  create(body: CreateSessionRequest): SessionResponse;
  get(id: string): SessionResponse;
  updateState(id: string, body: unknown): UpdateStateResponse;
  computeResult(id: string): { result: ResultDef };
}

export function createSessionsService(
  sessions: SessionsRepo,
  events: EventsRepo,
  versions: VersionsService,
): SessionsService {
  /** Loads a live session with the config of *its* version, never the active one. */
  const load = (id: string): { row: SessionRow; config: FunnelConfig } => {
    const row = sessions.getById(id);
    if (!row) throw new HttpError(404, 'session_not_found', `Session ${id} does not exist`);
    if (Date.parse(row.expires_at) < Date.now()) {
      throw new HttpError(410, 'session_expired', 'This session has expired; start a new one');
    }
    const config = versions.getConfig(row.version);
    if (!config) throw new HttpError(500, 'config_missing', `Config for version ${row.version} is not available`);
    return { row, config };
  };

  return {
    create(body) {
      const active = versions.getActive();
      if (!active) throw new HttpError(503, 'no_active_version', 'No funnel version is published yet');
      const config = active.config;
      const query = body.query ?? {};

      const requested = body.variantOverride ?? query[config.experiment.overrideQueryParam];
      const isKnown = requested !== undefined && Object.hasOwn(config.experiment.variants, requested);
      const variant = isKnown ? requested : pickWeightedVariant(config);
      const assignmentSource: AssignmentSource = isKnown ? 'override' : 'server';

      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + config.session.ttlHours * 3600 * 1000).toISOString();
      const row: SessionRow = {
        id: randomUUID(),
        funnel_id: config.funnelId,
        version: active.version,
        variant,
        experiment_id: config.experiment.id,
        assignment_source: assignmentSource,
        utm_source: body.utm?.source ?? query.utm_source ?? null,
        utm_medium: body.utm?.medium ?? query.utm_medium ?? null,
        utm_campaign: body.utm?.campaign ?? query.utm_campaign ?? null,
        answers_json: '{}',
        current_step_id: null,
        result_id: null,
        created_at: createdAt,
        updated_at: createdAt,
        expires_at: expiresAt,
      };
      sessions.insert(row);

      // session_started is the one event the server owns; the client never sends it.
      events.insert({
        event_id: randomUUID(),
        session_id: row.id,
        name: 'session_started',
        client_timestamp: toIsoTimestamp(body.clientTimestamp) ?? createdAt,
        server_timestamp: createdAt,
        funnel_id: row.funnel_id,
        funnel_version: row.version,
        experiment_id: row.experiment_id,
        variant: row.variant,
        assignment_source: row.assignment_source,
        step_id: null,
        utm_source: row.utm_source,
        utm_medium: row.utm_medium,
        utm_campaign: row.utm_campaign,
        properties_json: '{}',
      });

      return { session: toDto(row), config };
    },

    get(id) {
      const { row, config } = load(id);
      return { session: toDto(row), config };
    },

    updateState(id, body) {
      const { row, config } = load(id);
      const payload = (isPlainObject(body) ? body : {}) as { answers?: unknown; currentStepId?: unknown };
      if (!isPlainObject(payload.answers)) {
        throw new HttpError(400, 'invalid_body', '`answers` must be an object of answer key → value');
      }
      const resolved = resolveVariant(config, row.variant);

      const stepByAnswerKey = new Map(
        resolved.steps.flatMap((step) => {
          const key = answerKey(step);
          return key === null ? [] : [[key, step] as const];
        }),
      );

      const answers: Answers = {};
      for (const [key, raw] of Object.entries(payload.answers)) {
        const step = stepByAnswerKey.get(key);
        if (!step) {
          throw new HttpError(400, 'unknown_answer', `"${key}" is not an answer of variant ${row.variant}`, { key });
        }
        const result = validateAnswer(step, raw);
        if (!result.ok) throw new HttpError(400, 'invalid_answer', result.message, { key, message: result.message });
        if (result.value !== undefined) answers[key] = result.value;
      }

      const currentStepId = payload.currentStepId;
      if (typeof currentStepId !== 'string' || !resolved.steps.some((s) => s.id === currentStepId)) {
        throw new HttpError(400, 'unknown_step', `"${String(currentStepId)}" is not a step of variant ${row.variant}`, {
          currentStepId,
        });
      }

      const updatedAt = new Date().toISOString();
      sessions.updateState(id, JSON.stringify(answers), currentStepId, updatedAt);
      return { session: toDto({ ...row, answers_json: JSON.stringify(answers), current_step_id: currentStepId, updated_at: updatedAt }) };
    },

    computeResult(id) {
      const { row, config } = load(id);
      const resolved = resolveVariant(config, row.variant);
      const result = computeResultFromEngine(resolved, parseAnswers(row.answers_json));
      sessions.setResult(id, result.id, new Date().toISOString());
      return { result };
    },
  };
}

/** Weighted random over `experiment.variants[].weight`; weights are positive by schema. */
function pickWeightedVariant(config: FunnelConfig): string {
  const entries = Object.entries(config.experiment.variants);
  const total = entries.reduce((sum, [, def]) => sum + def.weight, 0);
  let ticket = Math.random() * total;
  for (const [key, def] of entries) {
    ticket -= def.weight;
    if (ticket < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

function toIsoTimestamp(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function toDto(row: SessionRow): SessionDto {
  return {
    id: row.id,
    funnelId: row.funnel_id,
    version: row.version,
    variant: row.variant,
    experimentId: row.experiment_id,
    assignmentSource: row.assignment_source,
    utm: { source: row.utm_source, medium: row.utm_medium, campaign: row.utm_campaign },
    answers: parseAnswers(row.answers_json),
    currentStepId: row.current_step_id,
    resultId: row.result_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function parseAnswers(json: string): Answers {
  try {
    const parsed: unknown = JSON.parse(json);
    return isPlainObject(parsed) ? (parsed as Answers) : {};
  } catch {
    return {};
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
