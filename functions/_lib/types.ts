export const STEP_TYPES = [
  'llm_call',
  'http_request',
  'db_write',
  'notify',
  'conditional_branch',
  'approval_gate',
] as const;

export type StepType = (typeof STEP_TYPES)[number];

export const PRIVILEGED_STEP_TYPES = ['db_write', 'notify'] satisfies readonly StepType[];

export type OrgRole = 'owner' | 'editor' | 'viewer';
export type TriggerType = 'manual' | 'webhook' | 'scheduled' | 'database_event';

export type RunStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export type WorkflowStepRow = {
  id: string;
  workflow_id: string;
  step_order: number;
  step_type: StepType;
  name: string;
  config: Record<string, unknown>;
  created_by: string | null;
};

export type StepRunRow = {
  id: string;
  workflow_step_id: string;
  step_order: number;
  status: StepRunStatus;
  output: unknown;
  attempt_count: number;
};

export type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  org_id: string;
  status: RunStatus;
  context: RunContext;
  resume_from_step_order: number | null;
};

export type RunContext = {
  trigger: { type: TriggerType; payload: unknown };
  steps: Record<string, { output: unknown }>;
};

export type StepExecutionResult = {
  output: unknown;
  nextStepOrder?: number | null;
};

export type StepExecutor = (args: {
  step: WorkflowStepRow;
  run: WorkflowRunRow;
  context: RunContext;
  input: unknown;
  attempt: number;
}) => Promise<StepExecutionResult>;
