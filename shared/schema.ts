import { z } from 'zod';
import type { FunnelConfig } from './types';

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

const variantSchema = z
  .object({
    weight: z.number().positive(),
    stepSequence: z.array(z.string().min(1)).min(1),
    stepOverrides: z.record(z.string(), z.unknown()).optional(),
    resultOverrides: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

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
        ttlHours: z.number().positive(),
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
  .superRefine((cfg, ctx) => {
    if (Object.keys(cfg.experiment.variants).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['experiment', 'variants'], message: 'At least one variant is required' });
    }
    for (const [variantKey, variant] of Object.entries(cfg.experiment.variants)) {
      const seq = variant.stepSequence;
      seq.forEach((stepId, i) => {
        if (!cfg.steps[stepId]) {
          ctx.addIssue({
            code: 'custom',
            path: ['experiment', 'variants', variantKey, 'stepSequence', i],
            message: `Unknown step "${stepId}"`,
          });
        }
      });
      const resultSteps = seq.filter((id) => cfg.steps[id]?.type === 'result');
      const last = seq[seq.length - 1];
      if (resultSteps.length !== 1 || cfg.steps[last!]?.type !== 'result') {
        ctx.addIssue({
          code: 'custom',
          path: ['experiment', 'variants', variantKey, 'stepSequence'],
          message: 'Sequence must contain exactly one result step and it must be last',
        });
      }
      if (new Set(seq).size !== seq.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['experiment', 'variants', variantKey, 'stepSequence'],
          message: 'Sequence contains duplicate step ids',
        });
      }
      for (const id of Object.keys(variant.stepOverrides ?? {})) {
        if (!cfg.steps[id]) {
          ctx.addIssue({
            code: 'custom',
            path: ['experiment', 'variants', variantKey, 'stepOverrides', id],
            message: `Override for unknown step "${id}"`,
          });
        }
      }
      for (const id of Object.keys(variant.resultOverrides ?? {})) {
        if (!cfg.results[id]) {
          ctx.addIssue({
            code: 'custom',
            path: ['experiment', 'variants', variantKey, 'resultOverrides', id],
            message: `Override for unknown result "${id}"`,
          });
        }
      }
    }
    for (const [stepId, step] of Object.entries(cfg.steps)) {
      if (step.id !== stepId) {
        ctx.addIssue({ code: 'custom', path: ['steps', stepId, 'id'], message: 'Step id must match its key' });
      }
      const needsInput = step.type === 'single-select' || step.type === 'multi-select' || step.type === 'number';
      if (needsInput && !step.input) {
        ctx.addIssue({ code: 'custom', path: ['steps', stepId, 'input'], message: `Step type ${step.type} requires input` });
      }
      if ((step.type === 'single-select' || step.type === 'multi-select') && !(step.input?.options?.length)) {
        ctx.addIssue({ code: 'custom', path: ['steps', stepId, 'input', 'options'], message: 'Select step requires options' });
      }
    }
    cfg.resultRules.forEach((rule, i) => {
      if (!cfg.results[rule.resultId]) {
        ctx.addIssue({ code: 'custom', path: ['resultRules', i, 'resultId'], message: `Unknown result "${rule.resultId}"` });
      }
    });
    if (!cfg.results[cfg.defaultResultId]) {
      ctx.addIssue({ code: 'custom', path: ['defaultResultId'], message: `Unknown result "${cfg.defaultResultId}"` });
    }
    const names = cfg.events.allowed.map((e) => e.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['events', 'allowed'], message: 'Duplicate event names' });
    }
  });

/** Parses and validates a raw funnel config. Throws ZodError on invalid input. */
export function parseFunnelConfig(raw: unknown): FunnelConfig {
  return funnelConfigSchema.parse(raw) as unknown as FunnelConfig;
}

export function safeParseFunnelConfig(raw: unknown): { ok: true; config: FunnelConfig } | { ok: false; issues: z.core.$ZodIssue[] } {
  const res = funnelConfigSchema.safeParse(raw);
  if (res.success) return { ok: true, config: res.data as unknown as FunnelConfig };
  return { ok: false, issues: res.error.issues };
}
