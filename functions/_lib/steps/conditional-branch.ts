import { z } from 'zod';
import { PermanentError } from '../retry.ts';
import { resolveTemplates } from '../template.ts';
import type { StepExecutor } from '../types.ts';

const OPERATORS = {
  equals: (left: unknown, right: unknown) => String(left) === String(right),
  not_equals: (left: unknown, right: unknown) => String(left) !== String(right),
  contains: (left: unknown, right: unknown) =>
    String(left).toLowerCase().includes(String(right).toLowerCase()),
  not_contains: (left: unknown, right: unknown) =>
    !String(left).toLowerCase().includes(String(right).toLowerCase()),
  greater_than: (left: unknown, right: unknown) => Number(left) > Number(right),
  less_than: (left: unknown, right: unknown) => Number(left) < Number(right),
  is_truthy: (left: unknown) => Boolean(left) && left !== 'false' && left !== '0',
} as const;

export const BRANCH_OPERATORS = Object.keys(OPERATORS) as (keyof typeof OPERATORS)[];

const configSchema = z.object({
  left: z.string(),
  operator: z.enum(BRANCH_OPERATORS as [string, ...string[]]),
  right: z.union([z.string(), z.number(), z.boolean()]).optional(),
  then_step_order: z.number().int().positive().nullable().optional(),
  else_step_order: z.number().int().positive().nullable().optional(),
});

export const executeConditionalBranch: StepExecutor = async ({ step, context }) => {
  const config = configSchema.parse(step.config);

  const left = resolveTemplates(config.left, context);
  const right = config.right === undefined ? undefined : resolveTemplates(config.right, context);

  const operator = OPERATORS[config.operator as keyof typeof OPERATORS];
  if (!operator) throw new PermanentError(`Unknown branch operator "${config.operator}"`);

  const matched = operator(left, right);
  const target = matched ? config.then_step_order : config.else_step_order;

  // The resolved operand is persisted alongside the verdict so "why did it take the
  // else branch?" is answerable from the run record rather than by re-running it.
  return {
    output: {
      matched,
      operator: config.operator,
      evaluated_left: left,
      evaluated_right: right ?? null,
      next_step_order: target ?? null,
    },
    nextStepOrder: target ?? null,
  };
};
