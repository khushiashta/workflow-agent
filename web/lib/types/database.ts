export const STEP_TYPES = [
  'llm_call',
  'http_request',
  'conditional_branch',
  'approval_gate',
  'db_write',
  'notify',
] as const;

export type StepType = (typeof STEP_TYPES)[number];

/** Owner-only to author. Kept in sync with the Hasura insert/update checks by name. */
export const PRIVILEGED_STEP_TYPES: readonly StepType[] = ['db_write', 'notify'];

export const TRIGGER_TYPES = ['manual', 'webhook', 'scheduled', 'database_event'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Owner-only to author: a webhook trigger mints an unauthenticated door into the org. */
export const PRIVILEGED_TRIGGER_TYPES: readonly TriggerType[] = ['webhook'];

export type OrgRole = 'owner' | 'editor' | 'viewer';

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type Organization = {
  id: string;
  name: string;
  slug: string;
};

export type OrgMembership = {
  id: string;
  org_id: string;
  role: OrgRole;
  organization: Organization;
};

export type UsageSummary = {
  org_id: string;
  quota_calls_allowed: number;
  quota_calls_used: number;
  quota_calls_remaining: number;
  runs_this_period: number;
  failed_runs_this_period: number;
  avg_run_seconds_this_period: number | null;
};

export type WorkflowStep = {
  id: string;
  step_order: number;
  step_type: StepType;
  name: string;
  config: Record<string, unknown>;
};

export type WorkflowTrigger = {
  id: string;
  trigger_type: TriggerType;
  is_enabled: boolean;
  config: Record<string, unknown>;
};

export type WorkflowRunSummary = {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type Workflow = {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
  runs: WorkflowRunSummary[];
};

export type StepRun = {
  id: string;
  step_order: number;
  status: StepRunStatus;
  attempt_count: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  approved_at: string | null;
  approval_comment: string | null;
  started_at: string | null;
  finished_at: string | null;
  approver: { id: string; displayName: string } | null;
  step: { id: string; name: string; step_type: StepType; config: Record<string, unknown> } | null;
};

export type WorkflowRun = {
  id: string;
  status: RunStatus;
  trigger_type: TriggerType;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  workflow: { id: string; name: string; org_id: string } | null;
};
