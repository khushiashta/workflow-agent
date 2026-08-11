import type { Request, Response } from 'express';
import { authorizeWorkflowAccess, requireUserId } from '../_lib/authorization.ts';
import { createRun, executeRun } from '../_lib/engine.ts';
import { sendError } from '../_lib/errors.ts';
import { assertQuotaAvailable } from '../_lib/quota.ts';
import type { SessionVariables } from '../_lib/authorization.ts';

type ActionRequest = {
  input: { workflow_id: string; payload?: unknown };
  session_variables: SessionVariables;
};

export default async function handler(req: Request, res: Response) {
  try {
    const { input, session_variables: sessionVariables } = req.body as ActionRequest;

    // Authorization first, before any admin-secret query touches the resource. The
    // order is the control: a lookup that runs before the membership check is the
    // vulnerability no matter what follows it.
    const userId = requireUserId(sessionVariables);
    const access = await authorizeWorkflowAccess(input.workflow_id, userId, ['owner', 'editor']);

    assertQuotaAvailable(access.organization);

    const runId = await createRun({
      workflowId: access.workflowId,
      orgId: access.orgId,
      triggerType: 'manual',
      triggeredBy: userId,
      payload: input.payload ?? {},
    });

    const status = await executeRun(runId);

    return res.status(200).json({ workflow_run_id: runId, status });
  } catch (error) {
    return sendError(res, error);
  }
}
