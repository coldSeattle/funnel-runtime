import { z } from 'zod';
import { resolveVariant } from './engine/resolve';
import { answerKey } from './engine/visibility';
import type { Condition, FunnelConfig, Step, StepType } from './types';

const stepTypeSchema = z.enum(['info', 'single-select', 'multi-select', 'number', 'result']);

const operatorSchema = z.enum(['eq', 'neq', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte']);

const conditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ answer: z.string().min(1), operator: operatorSchema, value: z.unknown() }),
    z.object({ any: z.array(conditionSchema).min(1) }),
    z.object({ all: z.array(conditionSchema).min(1) }),
  ]),
);

const stepContentSchema = z
  .object({
    eyebrow: z.string().optional(),
    title: z.string().optional(),
    helperText: z.string().optional(),
    body: z.string().optional(),
    primaryActionLabel: z.string().optional(),
    loadingTitle: z.string().optional(),
    errorTitle: z.string().optional(),
    retryLabel: z.string().optional(),
  })
  .loose();

const stepSchema = z
  .object({
    id: z.string().min(1),
    type: stepTypeSchema,
    content: stepContentSchema,
    input: z
      .object({
        name: z.string().min(1),
        options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
        step: z.number().positive().optional(),
        unit: z.string().optional(),
      })
      .loose()
      .optional(),
    validation: z
      .object({
        required: z.boolean().optional(),
        minSelections: z.number().int().nonnegative().optional(),
        maxSelections: z.number().int().positive().optional(),
        messages: z.record(z.string(), z.string()).optional(),
      })
      .loose()
      .optional(),
    visibleWhen: conditionSchema.optional(),
    resultSource: z.string().optional(),
  })
  .loose();

const resultSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    summary: z.string(),
    recommendations: z.array(z.string()),
    cta: z.object({ label: z.string(), action: z.string() }).loose(),
  })
  .loose();

// Overrides are partial steps / results; they are checked after merging (see superRefine below).
const variantSchema = z
  .object({
    weight: z.number().positive(),
    stepSequence: z.array(z.string().min(1)).min(1),
    stepOverrides: z.record(z.string(), z.unknown()).optional(),
    resultOverrides: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** A year: longer would outlive any campaign, and a huge value makes expires_at an invalid date. */
const MAX_TTL_HOURS = 8760;

type Path = PropertyKey[];

export const funnelConfigSchema = z
  .object({
    schemaVersion: z.string(),
    funnelId: z.string().min(1),
    version: z.number().int().positive(),
    status: z.string().optional(),
    locale: z.string().optional(),
    title: z.string(),
    description: z.string().optional(),
    releaseNote: z.string().optional(),
    session: z
      .object({
        ttlHours: z.number().positive().max(MAX_TTL_HOURS),
        persistAnswers: z.boolean().optional(),
        pinVersion: z.boolean().optional(),
        pinExperimentVariant: z.boolean().optional(),
      })
      .loose(),
    progress: z
      .object({
        countVisibleOnly: z.boolean(),
        excludeTypes: z.array(stepTypeSchema),
      })
      .loose(),
    experiment: z
      .object({
        id: z.string().min(1),
        assignment: z.string(),
        sticky: z.boolean(),
        overrideQueryParam: z.string().min(1),
        variants: z.record(z.string().min(1), variantSchema),
      })
      .loose(),
    steps: z.record(z.string(), stepSchema),
    resultRules: z.array(z.object({ resultId: z.string().min(1), when: conditionSchema }).loose()),
    defaultResultId: z.string().min(1),
    results: z.record(z.string(), resultSchema),
    events: z
      .object({
        baseProperties: z.array(z.string()),
        allowed: z.array(
          z
            .object({
              name: z.string().min(1),
              trigger: z.string().optional(),
              properties: z.array(z.string()),
            })
            .loose(),
        ),
        privacy: z
          .object({
            storeRawAnswers: z.boolean(),
            allowAnswerKinds: z.boolean(),
          })
          .loose(),
      })
      .loose(),
  })
  .loose()
  .superRefine((parsed, ctx) => {
    const cfg = parsed as unknown as FunnelConfig;
    const issue = (path: Path, message: string) => ctx.addIssue({ code: 'custom', path, message });

    if (Object.keys(cfg.experiment.variants).length === 0) {
      issue(['experiment', 'variants'], 'At least one variant is required');
    }

    // Answer keys any step can produce: base steps, plus keys that variant overrides rename to.
    const knownKeys = new Set<string>();
    const keyOwner = new Map<string, string>();
    for (const [stepId, step] of Object.entries(cfg.steps)) {
      checkStepRules(step, stepId, ['steps', stepId], issue);
      const name = step.input?.name;
      if (name === undefined) continue;
      const owner = keyOwner.get(name);
      if (owner !== undefined) {
        issue(['steps', stepId, 'input', 'name'], `Answer key "${name}" is already used by step "${owner}"`);
      } else {
        keyOwner.set(name, stepId);
      }
      const key = answerKey(step);
      if (key !== null) knownKeys.add(key);
    }
    for (const [resultId, result] of Object.entries(cfg.results)) {
      if (result.id !== resultId) issue(['results', resultId, 'id'], 'Result id must match its key');
    }

    for (const [variantKey, variant] of Object.entries(cfg.experiment.variants)) {
      const at: Path = ['experiment', 'variants', variantKey];
      const seq = variant.stepSequence;
      let resolvable = true;
      seq.forEach((stepId, i) => {
        if (!Object.hasOwn(cfg.steps, stepId)) {
          issue([...at, 'stepSequence', i], `Unknown step "${stepId}"`);
          resolvable = false;
        }
      });
      if (new Set(seq).size !== seq.length) issue([...at, 'stepSequence'], 'Sequence contains duplicate step ids');
      for (const id of Object.keys(variant.stepOverrides ?? {})) {
        if (!Object.hasOwn(cfg.steps, id)) issue([...at, 'stepOverrides', id], `Override for unknown step "${id}"`);
      }
      for (const id of Object.keys(variant.resultOverrides ?? {})) {
        if (!Object.hasOwn(cfg.results, id)) issue([...at, 'resultOverrides', id], `Override for unknown result "${id}"`);
      }
      const baseTypes = (): (StepType | undefined)[] => seq.map((id) => (Object.hasOwn(cfg.steps, id) ? cfg.steps[id]!.type : undefined));
      if (!resolvable) {
        checkResultLast(baseTypes(), at, issue);
        continue;
      }

      // What sessions of this variant will actually render: the engine's own merge, validated again.
      const resolved = resolveVariant(cfg, variantKey);
      let stepsValid = true;
      resolved.steps.forEach((step, i) => {
        const id = seq[i]!;
        if (!variant.stepOverrides?.[id]) return;
        const path: Path = [...at, 'stepOverrides', id];
        const res = stepSchema.safeParse(step);
        if (!res.success) {
          for (const iss of res.error.issues) issue([...path, ...iss.path], iss.message);
          stepsValid = false;
        } else if (!checkStepRules(step, id, path, issue)) {
          stepsValid = false;
        }
      });
      for (const [resultId, result] of Object.entries(resolved.results)) {
        if (!variant.resultOverrides?.[resultId]) continue;
        const path: Path = [...at, 'resultOverrides', resultId];
        const res = resultSchema.safeParse(result);
        if (!res.success) {
          for (const iss of res.error.issues) issue([...path, ...iss.path], iss.message);
        } else if (result.id !== resultId) {
          issue([...path, 'id'], 'Result id must match its key');
        }
      }
      if (!stepsValid) {
        checkResultLast(baseTypes(), at, issue);
        continue;
      }
      checkResultLast(
        resolved.steps.map((s) => s.type),
        at,
        issue,
      );

      // A step may only depend on answers asked before it in this variant's order; anything else
      // is never known when the step is reached, so the step would silently never show.
      const asked = new Map<string, { id: string; renamed: boolean }>();
      resolved.steps.forEach((step, i) => {
        const id = seq[i]!;
        const override = variant.stepOverrides?.[id] as Partial<Step> | undefined;
        if (step.visibleWhen) {
          const path: Path =
            override?.visibleWhen !== undefined ? [...at, 'stepOverrides', id, 'visibleWhen'] : ['steps', id, 'visibleWhen'];
          for (const leaf of conditionLeaves(step.visibleWhen)) {
            if (!asked.has(leaf.answer)) {
              issue(
                [...path, ...leaf.path],
                `In variant ${variantKey}, step "${id}" depends on answer "${leaf.answer}", which no earlier step of the sequence asks for`,
              );
            }
          }
        }
        const key = answerKey(step);
        if (key === null) return;
        knownKeys.add(key);
        const renamed = override?.input?.name !== undefined;
        const owner = asked.get(key);
        if (owner === undefined) {
          asked.set(key, { id, renamed });
          return;
        }
        // Base collisions are reported once under `steps`; only a rename by an override is new here.
        if (renamed || owner.renamed) {
          const [culprit, other] = renamed ? [id, owner.id] : [owner.id, id];
          issue([...at, 'stepOverrides', culprit, 'input', 'name'], `Answer key "${key}" is already used by step "${other}"`);
        }
      });
    }

    cfg.resultRules.forEach((rule, i) => {
      if (!Object.hasOwn(cfg.results, rule.resultId)) {
        issue(['resultRules', i, 'resultId'], `Unknown result "${rule.resultId}"`);
      }
      for (const leaf of conditionLeaves(rule.when)) {
        if (!knownKeys.has(leaf.answer)) {
          issue(['resultRules', i, 'when', ...leaf.path], `Unknown answer "${leaf.answer}": no step asks for it`);
        }
      }
    });
    if (!Object.hasOwn(cfg.results, cfg.defaultResultId)) {
      issue(['defaultResultId'], `Unknown result "${cfg.defaultResultId}"`);
    }
    const names = cfg.events.allowed.map((e) => e.name);
    if (new Set(names).size !== names.length) {
      issue(['events', 'allowed'], 'Duplicate event names');
    }
  });

/** Rules a step must satisfy beyond its shape; returns false when any of them failed. */
function checkStepRules(step: Step, id: string, path: Path, issue: (path: Path, message: string) => void): boolean {
  let ok = true;
  const fail = (sub: Path, message: string) => {
    issue([...path, ...sub], message);
    ok = false;
  };
  if (step.id !== id) fail(['id'], 'Step id must match its key');
  const needsInput = step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
  if (needsInput && !step.input) fail(['input'], `Step type ${step.type} requires input`);
  if ((step.type === 'single-select' || step.type === 'multi-select') && !step.input?.options?.length) {
    fail(['input', 'options'], 'Select step requires options');
  }
  return ok;
}

function checkResultLast(types: (StepType | undefined)[], at: Path, issue: (path: Path, message: string) => void): void {
  if (types.filter((t) => t === 'result').length !== 1 || types.at(-1) !== 'result') {
    issue([...at, 'stepSequence'], 'Sequence must contain exactly one result step and it must be last');
  }
}

/** Every leaf of a condition, with its path inside the condition. Mirrors evaluateCondition: `any`, then `all`. */
function conditionLeaves(cond: Condition, path: Path = []): { answer: string; path: Path }[] {
  if ('any' in cond) return cond.any.flatMap((c, i) => conditionLeaves(c, [...path, 'any', i]));
  if ('all' in cond) return cond.all.flatMap((c, i) => conditionLeaves(c, [...path, 'all', i]));
  return [{ answer: cond.answer, path: [...path, 'answer'] }];
}

/** Parses and validates a raw funnel config. Throws ZodError on invalid input. */
export function parseFunnelConfig(raw: unknown): FunnelConfig {
  return funnelConfigSchema.parse(raw) as unknown as FunnelConfig;
}

export function safeParseFunnelConfig(raw: unknown): { ok: true; config: FunnelConfig } | { ok: false; issues: z.core.$ZodIssue[] } {
  const res = funnelConfigSchema.safeParse(raw);
  if (res.success) return { ok: true, config: res.data as unknown as FunnelConfig };
  return { ok: false, issues: res.error.issues };
}
