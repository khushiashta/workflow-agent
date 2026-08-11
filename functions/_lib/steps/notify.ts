import { z } from 'zod';
import { adminRequest } from '../admin-client.ts';
import { resolveTemplates } from '../template.ts';
import type { StepExecutor } from '../types.ts';

const configSchema = z.object({
  channel: z.enum(['slack', 'email']),
  recipient: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
});

const INSERT_NOTIFICATION = `
  mutation InsertNotification($object: notifications_insert_input!) {
    insert_notifications_one(object: $object) {
      id
      status
    }
  }
`;

/**
 * The step enqueues; it does not deliver. Calling Slack inline would make run latency
 * depend on a third party's availability and turn their outage into failed runs. The
 * notifications row is the durable record, and step success means "queued" — which the
 * run view shows as such rather than implying delivery.
 */
export function createNotifyExecutor(stepRunId: string): StepExecutor {
  return async ({ step, run, context }) => {
    const config = configSchema.parse(resolveTemplates(step.config, context));

    const { insert_notifications_one: notification } = await adminRequest<{
      insert_notifications_one: { id: string; status: string };
    }>(INSERT_NOTIFICATION, {
      object: {
        org_id: run.org_id,
        step_run_id: stepRunId,
        channel: config.channel,
        recipient: config.recipient,
        subject: config.subject ?? null,
        body: config.body,
      },
    });

    return {
      output: {
        notification_id: notification.id,
        status: notification.status,
        channel: config.channel,
        recipient: config.recipient,
      },
    };
  };
}
