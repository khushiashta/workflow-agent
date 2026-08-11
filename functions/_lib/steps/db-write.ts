import { z } from 'zod';
import { adminRequest } from '../admin-client.ts';
import { resolveTemplates } from '../template.ts';
import type { StepExecutor } from '../types.ts';

const configSchema = z.object({
  label: z.string().min(1),
  payload: z.unknown(),
});

const INSERT_STEP_OUTPUT = `
  mutation InsertStepOutput($object: step_outputs_insert_input!) {
    insert_step_outputs_one(object: $object) {
      id
    }
  }
`;

export function createDbWriteExecutor(stepRunId: string): StepExecutor {
  return async ({ step, run, context }) => {
    const config = configSchema.parse(step.config);
    const payload = resolveTemplates(config.payload, context);

    const { insert_step_outputs_one: inserted } = await adminRequest<{
      insert_step_outputs_one: { id: string };
    }>(INSERT_STEP_OUTPUT, {
      object: {
        // Taken from the run, never from config: a config-supplied org_id would let one
        // organization's workflow write rows into another's.
        org_id: run.org_id,
        step_run_id: stepRunId,
        label: config.label,
        payload,
      },
    });

    return { output: { step_output_id: inserted.id, label: config.label, payload } };
  };
}
