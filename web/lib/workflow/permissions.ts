import type { OrgRole, StepType, TriggerType } from '@/lib/types/database';
import { PRIVILEGED_STEP_TYPES, PRIVILEGED_TRIGGER_TYPES } from '@/lib/types/database';

/**
 * One module, derived from the same role vocabulary as the database, rather than
 * `role !== 'viewer'` scattered through components.
 *
 * Every predicate here is presentation only. Each one is enforced again in a Hasura
 * permission or in an Action handler, and the demo's cross-org checks pass because of
 * those, not because of this file. Hiding a control is a courtesy; the server refusing it
 * is the actual control.
 */

export const canEditWorkflow = (role: OrgRole) => role === 'owner' || role === 'editor';
export const canTriggerRun = (role: OrgRole) => role === 'owner' || role === 'editor';
export const canApproveStep = (role: OrgRole) => role === 'owner' || role === 'editor';
export const canDeleteWorkflow = (role: OrgRole) => role === 'owner';
export const canManageMembers = (role: OrgRole) => role === 'owner';

export const canAddStepType = (role: OrgRole, stepType: StepType) =>
  canEditWorkflow(role) && (role === 'owner' || !PRIVILEGED_STEP_TYPES.includes(stepType));

export const canAddTriggerType = (role: OrgRole, triggerType: TriggerType) =>
  canEditWorkflow(role) && (role === 'owner' || !PRIVILEGED_TRIGGER_TYPES.includes(triggerType));

export const canMintWebhookToken = (role: OrgRole) => role === 'owner';

export function whyStepTypeDisabled(role: OrgRole, stepType: StepType): string | null {
  if (!canEditWorkflow(role)) return 'Viewers cannot edit workflows';
  if (canAddStepType(role, stepType)) return null;
  return 'Only an owner can add a step that writes to the database or sends notifications';
}
