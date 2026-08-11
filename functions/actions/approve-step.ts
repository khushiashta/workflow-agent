import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminRequest, nowIso } from '../_lib/admin-client.ts';
import type { SessionVariables } from '../_lib/authorization.ts';
import { requireUserId } from '../_lib/authorization.ts';
import { conflict, forbidden, notFound, sendError } from '../_lib/errors.ts';
import { executeRun } from '../_lib/engine.ts';
import type { OrgRole } from '../_lib/types.ts';

type ActionRequest = {
  input: { step_run_id: string; comment?: string | null };
  session_variables: SessionVariables;
};

const DEFAULT_APPROVER_ROLES: readonly OrgRole[] = ['owner', 'editor'];

const gateConfigSchema = z.object({
  allowed_roles: z.array(z.enum(['owner', 'editor', 'viewer'])).nonempty().optional(),
});

type StepRunForApproval = {
  step_runs_by_pk: {
    id: string;
    status: string;
    workflow_run_id: string;
    step: { step_type: string; config: Record<string, unknown> };
    workflow_run: {
      status: string;
      workflow: {
        organization: { members: { role: OrgRole }[] };
      };
    };
  } | null;
};

const STEP_RUN_FOR_APPROVAL = `
  query StepRunForApproval($stepRunId: uuid!, $userId: uuid!) {
    step_runs_by_pk(id: $stepRunId) {
      id
      status
      workflow_run_id
      step {
        step_type
        config
      }
      workflow_run {
        status
        workflow {
          organization {
            members(where: { user_id: { _eq: $userId } }) {
              role
            }
          }
        }
      }
    }
  }
`;

const CLAIM_APPROVAL = `
  mutation ClaimApproval(
    $stepRunId: uuid!
    $userId: uuid!
    $comment: String
    $now: timestamptz!
  ) {
    update_step_runs(
      where: { id: { _eq: $stepRunId }, status: { _eq: "awaiting_approval" } }
      _set: {
        status: "succeeded"
        approved_by: $userId
        approved_at: $now
        approval_comment: $comment
        finished_at: $now
      }
    ) {
      affected_rows
    }
  }
`;

/**
 * Clearing an approval gate is the layer-2 check that cannot be a row permission.
 *
 * It depends on run state, it has to resume execution afterwards, and the gate may
 * narrow its own approvers through config. No role has insert or update permission on
 * step_runs, so this handler is the only path — and it re-derives the caller's role from
 * the database rather than trusting the role in the request.
 */
export default async function handler(req: Request, res: Response) {
  try {
    const { input, session_variables: sessionVariables } = req.body as ActionRequest;
    const userId = requireUserId(sessionVariables);

    const { step_runs_by_pk: stepRun } = await adminRequest<StepRunForApproval>(
      STEP_RUN_FOR_APPROVAL,
      { stepRunId: input.step_run_id, userId },
    );

    if (!stepRun) throw notFound('Step run not found');

    // Fetched in the same query as the resource: an Org B caller holding a real Org A
    // step_run_id gets an empty members array, so a valid id buys them nothing. The
    // message stays "not found" so it never confirms the row exists.
    const membership = stepRun.workflow_run.workflow.organization.members.at(0);
    if (!membership) throw notFound('Step run not found');

    if (stepRun.step.step_type !== 'approval_gate') {
      throw conflict('That step is not an approval gate');
    }

    const gateConfig = gateConfigSchema.parse(stepRun.step.config);
    const allowedRoles: readonly OrgRole[] = gateConfig.allowed_roles ?? DEFAULT_APPROVER_ROLES;

    // Checked against the membership row, not against x-hasura-role. Hasura proved the
    // caller holds this role somewhere; only the database proves they hold it here.
    if (!allowedRoles.includes(membership.role)) {
      throw forbidden(`Your role (${membership.role}) cannot approve this step`);
    }

    const claimed = await adminRequest<{ update_step_runs: { affected_rows: number } }>(
      CLAIM_APPROVAL,
      {
        stepRunId: stepRun.id,
        userId,
        comment: input.comment ?? null,
        now: nowIso(),
      },
    );

    // Conditional on awaiting_approval, so two approvers clicking at once produce one
    // approval and one clean conflict rather than two resumes of the same run.
    if (claimed.update_step_runs.affected_rows === 0) {
      throw conflict('This step is no longer awaiting approval');
    }

    const status = await executeRun(stepRun.workflow_run_id);

    return res.status(200).json({
      step_run_id: stepRun.id,
      workflow_run_id: stepRun.workflow_run_id,
      status,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
