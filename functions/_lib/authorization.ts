import { adminRequest } from './admin-client.ts';
import { forbidden, notFound } from './errors.ts';
import type { OrgRole } from './types.ts';

export type SessionVariables = Record<string, string | undefined>;

export type WorkflowAccess = {
  workflowId: string;
  orgId: string;
  role: OrgRole;
  organization: { quota_calls_allowed: number; quota_calls_used: number };
};

type WorkflowWithMembership = {
  workflows_by_pk: {
    id: string;
    org_id: string;
    is_active: boolean;
    organization: {
      quota_calls_allowed: number;
      quota_calls_used: number;
      members: { role: OrgRole }[];
    };
  } | null;
};

const WORKFLOW_WITH_MEMBERSHIP = `
  query WorkflowWithMembership($workflowId: uuid!, $userId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      org_id
      is_active
      organization {
        quota_calls_allowed
        quota_calls_used
        members(where: { user_id: { _eq: $userId } }) {
          role
        }
      }
    }
  }
`;

export function requireUserId(sessionVariables: SessionVariables): string {
  // Session variables are set by Hasura from the verified JWT and are the only
  // trustworthy identity in the request. Action input is attacker-controlled.
  const userId = sessionVariables['x-hasura-user-id'];
  if (!userId) throw forbidden('Authentication required');
  return userId;
}

/**
 * Resolves the organization from the workflow row, then checks the caller's membership
 * in that organization. Deriving the org from the resource rather than the request is
 * what stops a caller naming another tenant's workflow and having it evaluated against
 * their own membership.
 */
export async function authorizeWorkflowAccess(
  workflowId: string,
  userId: string,
  allowedRoles: readonly OrgRole[],
): Promise<WorkflowAccess> {
  const { workflows_by_pk: workflow } = await adminRequest<WorkflowWithMembership>(
    WORKFLOW_WITH_MEMBERSHIP,
    { workflowId, userId },
  );

  if (!workflow) throw notFound('Workflow not found');

  const membership = workflow.organization.members.at(0);
  if (!membership) throw notFound('Workflow not found');

  if (!allowedRoles.includes(membership.role)) {
    throw forbidden(`Your role (${membership.role}) cannot perform this action`);
  }
  if (!workflow.is_active) {
    throw forbidden('This workflow is inactive');
  }

  return {
    workflowId: workflow.id,
    orgId: workflow.org_id,
    role: membership.role,
    organization: workflow.organization,
  };
}
