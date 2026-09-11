// Funnel configuration model. Mirrors configs/funnel-v*.json; unknown fields are preserved
// by the parser but not modelled here.

export type AnswerValue = string | string[] | number;
export type Answers = Record<string, AnswerValue>;

export type StepType = 'info' | 'single-select' | 'multi-select' | 'number' | 'result';

export type Operator = 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

export interface LeafCondition {
  answer: string;
  operator: Operator;
  value: unknown;
}
export interface AnyCondition {
  any: Condition[];
}
export interface AllCondition {
  all: Condition[];
}
export type Condition = LeafCondition | AnyCondition | AllCondition;

export interface StepContent {
  eyebrow?: string;
  title?: string;
  helperText?: string;
  body?: string;
  primaryActionLabel?: string;
  loadingTitle?: string;
  errorTitle?: string;
  retryLabel?: string;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface StepInput {
  name: string;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface StepValidation {
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  messages?: Record<string, string>;
}

export interface Step {
  id: string;
  type: StepType;
  content: StepContent;
  input?: StepInput;
  validation?: StepValidation;
  visibleWhen?: Condition;
  resultSource?: string;
}

export interface ResultCta {
  label: string;
  action: string;
}

export interface ResultDef {
  id: string;
  title: string;
  summary: string;
  recommendations: string[];
  cta: ResultCta;
}

export interface ResultRule {
  resultId: string;
  when: Condition;
}

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface VariantDef {
  weight: number;
  stepSequence: string[];
  stepOverrides?: Record<string, DeepPartial<Step>>;
  resultOverrides?: Record<string, DeepPartial<ResultDef>>;
}

export interface ExperimentDef {
  id: string;
  assignment: string;
  sticky: boolean;
  overrideQueryParam: string;
  variants: Record<string, VariantDef>;
}

export interface EventDef {
  name: string;
  trigger?: string;
  properties: string[];
}

export interface FunnelConfig {
  schemaVersion: string;
  funnelId: string;
  version: number;
  status?: string;
  locale?: string;
  title: string;
  description?: string;
  releaseNote?: string;
  session: {
    ttlHours: number;
    persistAnswers?: boolean;
    pinVersion?: boolean;
    pinExperimentVariant?: boolean;
  };
  progress: {
    countVisibleOnly: boolean;
    excludeTypes: StepType[];
  };
  experiment: ExperimentDef;
  steps: Record<string, Step>;
  resultRules: ResultRule[];
  defaultResultId: string;
  results: Record<string, ResultDef>;
  events: {
    baseProperties: string[];
    allowed: EventDef[];
    privacy: {
      storeRawAnswers: boolean;
      allowAnswerKinds: boolean;
    };
  };
}

/** A funnel config with one experiment variant applied: ordered steps and merged results. */
export interface ResolvedFunnel {
  variant: string;
  steps: Step[];
  results: Record<string, ResultDef>;
  config: FunnelConfig;
}
