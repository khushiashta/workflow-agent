import type { Request, Response } from 'express';
import { adminRequest } from '../_lib/admin-client.ts';
import { createRun, executeRun } from '../_lib/engine.ts';
import { forbidden, notFound, sendError } from '../_lib/errors.ts';
import { assertQuotaAvailable } from '../_lib/quota.ts';
import { verifyWebhookToken } from '../_lib/webhook-token.ts';

type ActionRequest = {
  input: { workflow_id: string; token: string; payload?: unknown };
};

type WebhookTriggerLookup = {
  workflow_triggers: {
    id: string;
    is_enabled: boolean;
    webhook_secret_hash: string | null;
    workflow: {
      id: string;
      org_id: string;
      is_active: boolean;
      organization: { quota_calls_allowed: number; quota_calls_used: number };
    };
  }[];
};

const WEBHOOK_TRIGGER = `
  query WebhookTrigger($workflowId: uuid!) {
    workflow_triggers(
      where: {
        workflow_id: { _eq: $workflowId }
        trigger_type: { _eq: "webhook" }
        is_enabled: { _eq: true }
      }
      limit: 1
    ) {
      id
      is_enabled
      webhook_secret_hash
      workflow {
        id
        org_id
        is_active
        organization {
          quota_calls_allowed
          quota_calls_used
        }
      }
    }
  }
`;

/**
 * Reachable without a session, so the per-trigger token is the whole of authorization.
 *
 * Quota applies exactly as it does to a manual run: an unauthenticated entry point that
 * skipped quota would be a free amplifier pointed at the org's allowance.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const { input } = req.body as ActionRequest;

    const { workflow_triggers: triggers } = await adminRequest<WebhookTriggerLookup>(
      WEBHOOK_TRIGGER,
      { workflowId: input.workflow_id },
    );

    const trigger = triggers.at(0);
    // Same story as everywhere else: an unknown workflow and a workflow without a webhook
    // trigger are indistinguishable to the caller.
    if (!trigger?.webhook_secret_hash) {
      throw notFound('No enabled webhook trigger for this workflow');
    }

    if (!input.token || !verifyWebhookToken(input.token, trigger.webhook_secret_hash)) {
      throw forbidden('Invalid webhook token');
    }

    if (!trigger.workflow.is_active) throw forbidden('This workflow is inactive');

    assertQuotaAvailable(trigger.workflow.organization);

    const runId = await createRun({
      workflowId: trigger.workflow.id,
      orgId: trigger.workflow.org_id,
      triggerType: 'webhook',
      // No user is behind this call; the trigger row is the authorization subject.
      triggeredBy: null,
      payload: input.payload ?? {},
    });

    const status = await executeRun(runId);

    return res.status(200).json({ workflow_run_id: runId, status });
  } catch (error) {
    return sendError(res, error);
  }
}
