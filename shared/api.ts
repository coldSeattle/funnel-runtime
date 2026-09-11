// HTTP API contract shared by server and web. See docs/design.md §5, §7, §8.
import type { Answers, FunnelConfig, ResultDef, StepType } from './types';

export type AssignmentSource = 'server' | 'override';

export interface UtmDto {
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
}

export interface SessionDto {
  id: string;
  funnelId: string;
  version: number;
  variant: string;
  experimentId: string | null;
  assignmentSource: AssignmentSource;
  utm: UtmDto;
  answers: Answers;
  currentStepId: string | null;
  resultId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface CreateSessionRequest {
  utm?: UtmDto;
  /** All URL query params of the landing page; the server reads config.experiment.overrideQueryParam from it */
  query?: Record<string, string>;
  /** Explicit variant override; takes precedence over `query` */
  variantOverride?: string;
  clientTimestamp?: string;
}

export interface SessionResponse {
  session: SessionDto;
  config: FunnelConfig;
}

export interface UpdateStateRequest {
  answers: Answers;
  currentStepId: string;
}

export interface UpdateStateResponse {
  session: SessionDto;
}

export interface ResultResponse {
  result: ResultDef;
}

export interface IncomingEvent {
  event_id: string;
  session_id: string;
  name: string;
  client_timestamp: string;
  step_id?: string | null;
  properties?: Record<string, unknown>;
}

export interface IngestRequest {
  events: IncomingEvent[];
}

export type IngestStatus = 'accepted' | 'duplicate' | 'rejected';

export interface IngestResult {
  event_id: string | null;
  status: IngestStatus;
  /** Only on `rejected`: invalid_shape | unknown_session | unknown_event | invalid_properties | unknown_step */
  reason?: string;
}

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  rejected: number;
  results: IngestResult[];
}

export type VersionStatus = 'active' | 'published' | 'draft';

export interface VersionSummary {
  version: number;
  title: string;
  releaseNote: string | null;
  status: VersionStatus;
  createdAt: string;
  publishedAt: string | null;
  sessions: number;
}

export interface VersionsResponse {
  funnelId: string | null;
  activeVersion: number | null;
  /** The version POST /api/admin/rollback would activate (undo stack over the history); null → 409 */
  rollbackTarget: number | null;
  versions: VersionSummary[];
}

/**
 * An audit log row. Do not derive the rollback target from it (e.g. from the newest `fromVersion`):
 * rollback is an undo stack, so read `VersionsResponse.rollbackTarget` instead.
 */
export interface HistoryEntry {
  id: number;
  action: 'publish' | 'rollback';
  fromVersion: number | null;
  toVersion: number;
  at: string;
}

export interface HistoryResponse {
  history: HistoryEntry[];
}

/** POST /api/admin/versions → 201 */
export interface UploadVersionResponse {
  version: number;
}

/** POST /api/admin/versions/:version/publish and POST /api/admin/rollback → 200 */
export interface ActivationResponse {
  activeVersion: number;
  fromVersion: number | null;
}

export interface AnalyticsFilters {
  version?: number;
  variant?: string;
  utmCampaign?: string;
  excludeOverrides?: boolean;
}

export interface Totals {
  started: number;
  reachedResult: number;
  ctaClicked: number;
  /** ctaClicked / reachedResult, null when reachedResult = 0 */
  ctr: number | null;
  /** ctaClicked / started, null when started = 0 */
  primary: number | null;
}

export interface StepRow {
  stepId: string;
  type: StepType | null;
  reached: number;
  /** reached / started */
  reachRate: number | null;
  completed: number;
  /** completed / reached */
  completionRate: number | null;
  exits: number;
  /** exits / reached */
  exitRate: number | null;
}

export interface AnalyticsResponse {
  filters: AnalyticsFilters;
  options: {
    versions: number[];
    variants: string[];
    campaigns: string[];
  };
  totals: Totals;
  steps: StepRow[];
  exitsBeforeFirstStep: number;
  /** Pools every selected version: without a version filter it mixes different experiments. */
  byVariant: Record<string, Totals>;
  byVersion: Record<string, Totals>;
  /** funnel_version → variant → totals, same started-set rules: an A/B comparison within one experiment. */
  byVersionVariant: Record<string, Record<string, Totals>>;
}

export interface HealthResponse {
  ok: true;
  activeVersion: number | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
