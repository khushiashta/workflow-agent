import type { Request, Response } from 'express';
import { adminRequest } from '../_lib/admin-client.ts';
import type { SessionVariables } from '../_lib/authorization.ts';
import { authorizeWorkflowAccess, requireUserId } from '../_lib/authorization.ts';
import { sendError } from '../_lib/errors.ts';
import { mintWebhookToken } from '../_lib/webhook-token.ts';

type ActionRequest = {
  input: { workflow_id: string };
  session_variables: SessionVariables;
};

const UPSERT_WEBHOOK_TRIGGER = `
  mutation UpsertWebhookTrigger($object: workflow_triggers_insert_input!) {
    insert_workflow_triggers_one(object: $object) {
      id
    }
  }
`;

const DISABLE_EXISTING = `
  mutation DisableExistingWebhookTriggers($workflowId: uuid!) {
    delete_workflow_triggers(
      where: { workflow_id: { _eq: $workflowId }, trigger_type: { _eq: "webhook" } }
    ) {
      affected_rows
    }
  }
`;

/**
 * Creating a webhook trigger is owner-only, and not because writing the row is dangerous
 * — it is because the row mints an unauthenticated door into the organization's
 * workflows. That is a different class of act from adding an llm_call step, which is why
 * layer 2 treats it like db_write rather than like ordinary editing.
 *
 * Calling this again rotates the token: the previous one stops working immediately.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const { input, session_variables: sessionVariables } = req.body as ActionRequest;

    const userId = requireUserId(sessionVariables);
    const access = await authorizeWorkflowAccess(input.workflow_id, userId, ['owner']);

    const { token, hash } = mintWebhookToken();

    await adminRequest(DISABLE_EXISTING, { workflowId: access.workflowId });
    const { insert_workflow_triggers_one: trigger } = await adminRequest<{
      insert_workflow_triggers_one: { id: string };
    }>(UPSERT_WEBHOOK_TRIGGER, {
      object: {
        workflow_id: access.workflowId,
        trigger_type: 'webhook',
        is_enabled: true,
        config: {},
        webhook_secret_hash: hash,
        created_by: userId,
      },
    });

    return res.status(200).json({ workflow_trigger_id: trigger.id, token });
  } catch (error) {
    return sendError(res, error);
  }
}
