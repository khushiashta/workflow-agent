import { adminRequest, nowIso } from './admin-client.ts';
import { consumeQuota } from './quota.ts';
import { RetryExhaustedError, describeError, withRetry } from './retry.ts';
import { executeConditionalBranch } from './steps/conditional-branch.ts';
import { createDbWriteExecutor } from './steps/db-write.ts';
import { executeHttpRequest } from './steps/http-request.ts';
import { executeLlmCall } from './steps/llm-call.ts';
import { createNotifyExecutor } from './steps/notify.ts';
import type {
  RunContext,
  StepExecutor,
  StepRunRow,
  TriggerType,
  WorkflowRunRow,
  WorkflowStepRow,
} from './types.ts';

export type ExecuteRunOutcome = 'succeeded' | 'failed' | 'paused' | 'busy';

/**
 * There is no scheduler in this build, so a run that outlives its budget cannot be
 * resumed later. Failing it loudly beats leaving a row stuck in `running` forever,
 * which is indistinguishable from a hung engine. The upgrade path is a cron sweep over
 * runs whose heartbeat has gone stale, resuming from resume_from_step_order.
 */
const WALL_CLOCK_BUDGET_MS = 45_000;

const LOAD_STEPS = `
  query LoadSteps($workflowId: uuid!) {
    workflow_steps(where: { workflow_id: { _eq: $workflowId } }, order_by: { step_order: asc }) {
      id
      workflow_id
      step_order
      step_type
      name
      config
      created_by
    }
  }
`;

const CREATE_RUN = `
  mutation CreateRun($run: workflow_runs_insert_input!) {
    insert_workflow_runs_one(object: $run) {
      id
    }
  }
`;

const CLAIM_RUN = `
  mutation ClaimRun($runId: uuid!, $now: timestamptz!, $statuses: [String!]!) {
    update_workflow_runs(
      where: { id: { _eq: $runId }, status: { _in: $statuses } }
      _set: { status: "running", heartbeat_at: $now, error: null }
    ) {
      returning {
        id
        workflow_id
        org_id
        status
        context
        resume_from_step_order
      }
    }
  }
`;

const STAMP_STARTED_AT = `
  mutation StampStartedAt($runId: uuid!, $now: timestamptz!) {
    update_workflow_runs(
      where: { id: { _eq: $runId }, started_at: { _is_null: true } }
      _set: { started_at: $now }
    ) {
      affected_rows
    }
  }
`;

const LOAD_STEP_RUNS = `
  query LoadStepRuns($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { step_order: asc }) {
      id
      workflow_step_id
      step_order
      status
      attempt_count
      output
    }
  }
`;

const CLAIM_STEP_RUN = `
  mutation ClaimStepRun($stepRunId: uuid!, $now: timestamptz!, $input: jsonb) {
    update_step_runs(
      where: { id: { _eq: $stepRunId }, status: { _eq: "pending" } }
      _set: { status: "running", started_at: $now, input: $input, error: null }
    ) {
      affected_rows
    }
  }
`;

const PAUSE_FOR_APPROVAL = `
  mutation PauseForApproval($runId: uuid!, $stepRunId: uuid!, $stepOrder: Int!) {
    update_step_runs(
      where: { id: { _eq: $stepRunId }, status: { _eq: "pending" } }
      _set: { status: "awaiting_approval" }
    ) {
      affected_rows
    }
    update_workflow_runs_by_pk(
      pk_columns: { id: $runId }
      _set: { status: "paused", resume_from_step_order: $stepOrder }
    ) {
      id
    }
  }
`;

const FINISH_STEP_RUN = `
  mutation FinishStepRun(
    $stepRunId: uuid!
    $status: String!
    $output: jsonb
    $error: String
    $attemptCount: Int!
    $now: timestamptz!
  ) {
    update_step_runs_by_pk(
      pk_columns: { id: $stepRunId }
      _set: {
        status: $status
        output: $output
        error: $error
        attempt_count: $attemptCount
        finished_at: $now
      }
    ) {
      id
    }
  }
`;

const SKIP_STEPS = `
  mutation SkipSteps($runId: uuid!, $orders: [Int!]!, $now: timestamptz!) {
    update_step_runs(
      where: {
        workflow_run_id: { _eq: $runId }
        step_order: { _in: $orders }
        status: { _eq: "pending" }
      }
      _set: { status: "skipped", finished_at: $now }
    ) {
      affected_rows
    }
  }
`;

const FINISH_RUN = `
  mutation FinishRun(
    $runId: uuid!
    $status: String!
    $error: String
    $context: jsonb!
    $now: timestamptz!
  ) {
    update_workflow_runs_by_pk(
      pk_columns: { id: $runId }
      _set: {
        status: $status
        error: $error
        context: $context
        finished_at: $now
        resume_from_step_order: null
      }
    ) {
      id
      status
    }
  }
`;

export async function createRun(input: {
  workflowId: string;
  orgId: string;
  triggerType: TriggerType;
  triggeredBy: string | null;
  payload: unknown;
}): Promise<string> {
  const { workflow_steps: steps } = await adminRequest<{ workflow_steps: WorkflowStepRow[] }>(
    LOAD_STEPS,
    { workflowId: input.workflowId },
  );

  if (steps.length === 0) throw new Error('Workflow has no steps');

  // All step_runs are inserted `pending` in the same transaction as the run, so the
  // subscription renders the whole ladder from its first frame.
  const { insert_workflow_runs_one: run } = await adminRequest<{
    insert_workflow_runs_one: { id: string };
  }>(CREATE_RUN, {
    run: {
      workflow_id: input.workflowId,
      org_id: input.orgId,
      status: 'queued',
      trigger_type: input.triggerType,
      triggered_by: input.triggeredBy,
      context: { trigger: { type: input.triggerType, payload: input.payload ?? {} }, steps: {} },
      step_runs: {
        data: steps.map((step) => ({
          workflow_step_id: step.id,
          step_order: step.step_order,
          status: 'pending',
        })),
      },
    },
  });

  return run.id;
}

async function claimRun(runId: string, statuses: string[]): Promise<WorkflowRunRow | null> {
  const result = await adminRequest<{
    update_workflow_runs: { returning: WorkflowRunRow[] };
  }>(CLAIM_RUN, { runId, now: nowIso(), statuses });

  return result.update_workflow_runs.returning.at(0) ?? null;
}

function buildExecutor(stepType: string, stepRunId: string): StepExecutor | null {
  switch (stepType) {
    case 'llm_call':
      return executeLlmCall;
    case 'http_request':
      return executeHttpRequest;
    case 'conditional_branch':
      return executeConditionalBranch;
    case 'db_write':
      return createDbWriteExecutor(stepRunId);
    case 'notify':
      return createNotifyExecutor(stepRunId);
    default:
      return null;
  }
}

/**
 * Runs a workflow from its start, or from where an approval left it.
 *
 * Every state transition is a conditional update reporting affected_rows, so two
 * concurrent entries — a redelivered webhook, a double-clicked button, an approval
 * racing a retry — cannot execute the same step twice. Whoever loses the claim returns
 * `busy` rather than running.
 */
export async function executeRun(runId: string): Promise<ExecuteRunOutcome> {
  const startedAt = Date.now();

  // Claimed as two guarded updates rather than one: started_at must be stamped on the
  // first entry but left alone when resuming a paused run.
  const fresh = await claimRun(runId, ['queued']);
  if (fresh) await adminRequest(STAMP_STARTED_AT, { runId, now: nowIso() });
  const run = fresh ?? (await claimRun(runId, ['paused']));
  if (!run) return 'busy';

  const [{ workflow_steps: steps }, { step_runs: stepRuns }] = await Promise.all([
    adminRequest<{ workflow_steps: WorkflowStepRow[] }>(LOAD_STEPS, {
      workflowId: run.workflow_id,
    }),
    adminRequest<{ step_runs: StepRunRow[] }>(LOAD_STEP_RUNS, { runId }),
  ]);

  const stepRunByStepId = new Map(stepRuns.map((stepRun) => [stepRun.workflow_step_id, stepRun]));
  const stored = run.context as Partial<RunContext> | null;

  // Step outputs are rebuilt from step_runs rather than read back from the run's stored
  // context. They are the same data, but step_runs are written as each step finishes,
  // while the context column is only rewritten when the run ends — so a run resuming
  // after a pause would find an empty context and fail to resolve {{steps.N.output}}.
  // Rebuilding also means a crash mid-run loses nothing.
  const context: RunContext = {
    trigger: stored?.trigger ?? { type: 'manual', payload: {} },
    steps: Object.fromEntries(
      stepRuns
        .filter((stepRun) => stepRun.status === 'succeeded' && stepRun.output !== null)
        .map((stepRun) => [String(stepRun.step_order), { output: stepRun.output }]),
    ),
  };

  let index = run.resume_from_step_order
    ? steps.findIndex((step) => step.step_order === run.resume_from_step_order)
    : 0;
  if (index < 0) index = 0;

  while (index >= 0 && index < steps.length) {
    const step = steps[index];
    if (!step) break;

    const stepRun = stepRunByStepId.get(step.id);
    if (!stepRun) {
      index += 1;
      continue;
    }

    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      await finishRun(runId, 'failed', context, `Execution budget exceeded at step ${step.step_order}`);
      return 'failed';
    }

    if (step.step_type === 'approval_gate') {
      const paused = await adminRequest<{ update_step_runs: { affected_rows: number } }>(
        PAUSE_FOR_APPROVAL,
        { runId, stepRunId: stepRun.id, stepOrder: step.step_order },
      );
      // Zero rows means the gate was already cleared, so this entry is the resume.
      if (paused.update_step_runs.affected_rows > 0) return 'paused';
      index += 1;
      continue;
    }

    const claimed = await adminRequest<{ update_step_runs: { affected_rows: number } }>(
      CLAIM_STEP_RUN,
      { stepRunId: stepRun.id, now: nowIso(), input: step.config },
    );
    if (claimed.update_step_runs.affected_rows === 0) {
      index += 1;
      continue;
    }

    const executor = buildExecutor(step.step_type, stepRun.id);
    if (!executor) {
      const message = `Unsupported step type ${step.step_type}`;
      await finishStepRun(stepRun.id, 'failed', null, message, 1);
      await finishRun(runId, 'failed', context, message);
      return 'failed';
    }

    let result;
    try {
      const attempted = await withRetry((attempt) =>
        executor({ step, run, context, input: step.config, attempt }),
      );
      result = attempted.result;
      await finishStepRun(stepRun.id, 'succeeded', result.output, null, attempted.attemptCount);
    } catch (error) {
      const message = describeError(error);
      const attemptCount = error instanceof RetryExhaustedError ? error.attemptCount : 1;
      await finishStepRun(stepRun.id, 'failed', null, message, attemptCount);
      await finishRun(runId, 'failed', context, `Step ${step.step_order} failed: ${message}`);
      return 'failed';
    }

    context.steps[String(step.step_order)] = { output: result.output };

    if (step.step_type === 'conditional_branch') {
      if (result.nextStepOrder === null || result.nextStepOrder === undefined) {
        // A branch with no target on the chosen side ends the run cleanly.
        await skipSteps(runId, steps.slice(index + 1).map((candidate) => candidate.step_order));
        break;
      }

      const targetIndex = steps.findIndex(
        (candidate) => candidate.step_order === result.nextStepOrder,
      );
      if (targetIndex < 0) {
        const message = `Branch target step ${result.nextStepOrder} does not exist`;
        await finishRun(runId, 'failed', context, message);
        return 'failed';
      }

      await skipSteps(
        runId,
        steps.slice(index + 1, targetIndex).map((candidate) => candidate.step_order),
      );
      index = targetIndex;
      continue;
    }

    index += 1;
  }

  await finishRun(runId, 'succeeded', context, null);
  await consumeQuota(run.org_id);
  return 'succeeded';
}

async function skipSteps(runId: string, orders: number[]) {
  if (orders.length === 0) return;
  await adminRequest(SKIP_STEPS, { runId, orders, now: nowIso() });
}

async function finishStepRun(
  stepRunId: string,
  status: 'succeeded' | 'failed',
  output: unknown,
  error: string | null,
  attemptCount: number,
) {
  await adminRequest(FINISH_STEP_RUN, {
    stepRunId,
    status,
    output: output ?? null,
    error,
    attemptCount,
    now: nowIso(),
  });
}

async function finishRun(
  runId: string,
  status: 'succeeded' | 'failed',
  context: RunContext,
  error: string | null,
) {
  await adminRequest(FINISH_RUN, { runId, status, error, context, now: nowIso() });
}
