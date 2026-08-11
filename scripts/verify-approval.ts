/**
 * Approval-gate probes: pause, resume, cross-org refusal, and the double-approval race.
 *
 * The gate is the one layer-2 rule that cannot be a Hasura permission, so these probes
 * are the only evidence it is enforced. Every fixture is created and removed per run.
 *
 *   npm run verify:approval
 */

import {
  PROBE_PREFIX,
  adminRequest,
  createReporter,
  getToken,
  roleRequest,
  sweepProbeFixtures,
} from './_lib/api.ts';

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';

type StepRunSnapshot = {
  id: string;
  step_order: number;
  status: string;
  approved_by: string | null;
  approval_comment: string | null;
  output: Record<string, unknown> | null;
};

type RunSnapshot = {
  status: string;
  resume_from_step_order: number | null;
  step_runs: StepRunSnapshot[];
};

const TRIGGER = `
  mutation Trigger($id: uuid!, $payload: jsonb) {
    triggerWorkflowRun(workflow_id: $id, payload: $payload) { workflow_run_id status }
  }
`;

const APPROVE = `
  mutation Approve($stepRunId: uuid!, $comment: String) {
    approveStep(step_run_id: $stepRunId, comment: $comment) { status workflow_run_id }
  }
`;

const RUN_SNAPSHOT = `
  query RunSnapshot($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      status
      resume_from_step_order
      step_runs(order_by: { step_order: asc }) {
        id
        step_order
        status
        approved_by
        approval_comment
        output
      }
    }
  }
`;

const LATEST_RUN = `
  query LatestRun($workflowId: uuid!) {
    workflow_runs(
      where: { workflow_id: { _eq: $workflowId } }
      order_by: { created_at: desc }
      limit: 1
    ) {
      id
    }
  }
`;

type ActionOutcome = { status?: string; errorCode?: string; errorMessage?: string };

async function callAction(
  token: string,
  role: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<ActionOutcome> {
  const response = await roleRequest(token, role, query, variables);
  if (response.errorCode || response.errorMessage) {
    return { errorCode: response.errorCode, errorMessage: response.errorMessage };
  }
  const root = Object.values(response.data ?? {})[0] as { status?: string } | undefined;
  return { status: root?.status };
}

const snapshot = (runId: string) =>
  adminRequest<{ workflow_runs_by_pk: RunSnapshot }>(RUN_SNAPSHOT, { runId }).then(
    (data) => data.workflow_runs_by_pk,
  );

const latestRunId = (workflowId: string) =>
  adminRequest<{ workflow_runs: { id: string }[] }>(LATEST_RUN, { workflowId }).then(
    (data) => data.workflow_runs[0]?.id ?? '',
  );

const gateOf = (run: RunSnapshot) => run.step_runs.find((step) => step.step_order === 3);
const layout = (run: RunSnapshot) =>
  run.step_runs.map((step) => `${step.step_order}:${step.status}`).join(' ');

const createdWorkflowIds: string[] = [];

async function createGatedWorkflow(name: string, allowedRoles?: string[]): Promise<string> {
  const data = await adminRequest<{ insert_workflows_one: { id: string } }>(
    `mutation CreateWorkflow($object: workflows_insert_input!) {
       insert_workflows_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: ORG_A_ID,
        name,
        steps: {
          data: [
            {
              step_order: 1,
              step_type: 'llm_call',
              name: 'classify',
              config: {
                prompt:
                  'Reply with exactly one word, URGENT or NORMAL. Message: {{trigger.payload.text}}',
                temperature: 0,
                max_tokens: 8,
              },
            },
            {
              step_order: 2,
              step_type: 'conditional_branch',
              name: 'urgent?',
              config: {
                left: '{{steps.1.output.text}}',
                operator: 'contains',
                right: 'URGENT',
                then_step_order: 3,
                else_step_order: 5,
              },
            },
            {
              step_order: 3,
              step_type: 'approval_gate',
              name: 'approve escalation',
              config: allowedRoles ? { allowed_roles: allowedRoles } : {},
            },
            {
              step_order: 4,
              step_type: 'http_request',
              name: 'notify endpoint',
              config: { method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 },
            },
            {
              step_order: 5,
              step_type: 'db_write',
              name: 'record verdict',
              config: { label: 'triage_verdict', payload: { verdict: '{{steps.1.output.text}}' } },
            },
          ],
        },
      },
    },
  );
  createdWorkflowIds.push(data.insert_workflows_one.id);
  return data.insert_workflows_one.id;
}

const { check, report } = createReporter(58);

await sweepProbeFixtures();

const ownerA = await getToken('owner-a@example.com');
const editorA = await getToken('editor-a@example.com');
const viewerA = await getToken('viewer-a@example.com');
const ownerB = await getToken('owner-b@example.com');

// --- the URGENT path pauses at the gate ----------------------------------------------
const gatedId = await createGatedWorkflow(`${PROBE_PREFIX} approval default roles`);
const urgent = await callAction(ownerA, 'owner', TRIGGER, {
  id: gatedId,
  payload: { text: 'the checkout page is completely broken and we are losing orders' },
});
check('urgent payload pauses the run', urgent.status === 'paused', `status=${urgent.status ?? urgent.errorMessage}`);

const runId = await latestRunId(gatedId);
const paused = await snapshot(runId);
const gate = gateOf(paused);

check('gate step is awaiting_approval', gate?.status === 'awaiting_approval', `status=${gate?.status}`);
check('run records where to resume', paused.resume_from_step_order === 3, `resume_from=${paused.resume_from_step_order}`);
check(
  'downstream steps still pending',
  paused.step_runs.filter((step) => step.step_order > 3).every((step) => step.status === 'pending'),
  layout(paused),
);

const gateId = gate?.id ?? '';

// --- who may clear it ----------------------------------------------------------------
// A real step_run_id in the wrong tenant's hands must not even confirm the row exists.
const orgBApproval = await callAction(ownerB, 'owner', APPROVE, { stepRunId: gateId, comment: null });
check('Org B owner cannot approve', orgBApproval.errorCode === 'not-found', `code=${orgBApproval.errorCode ?? orgBApproval.status}`);
check(
  'Org B refusal says not-found, never forbidden',
  (orgBApproval.errorMessage ?? '').toLowerCase().includes('not found'),
  `msg=${(orgBApproval.errorMessage ?? '').slice(0, 32)}`,
);

// Every JWT carries all three roles as allowed, so a viewer can claim `editor` and get
// past the action permission. Only the handler's membership lookup refuses them.
const viewerApproval = await callAction(viewerA, 'editor', APPROVE, { stepRunId: gateId, comment: null });
check('viewer claiming editor cannot approve', viewerApproval.errorCode === 'forbidden', `code=${viewerApproval.errorCode ?? viewerApproval.status}`);

const stillPaused = await snapshot(runId);
check('run untouched by refused approvals', stillPaused.status === 'paused', `status=${stillPaused.status}`);
check('approved_by still empty', gateOf(stillPaused)?.approved_by === null, `approved_by=${String(gateOf(stillPaused)?.approved_by)}`);

// --- the double-approval race --------------------------------------------------------
// Two people watching the same paused run will both click.
const race = await Promise.all([
  callAction(editorA, 'editor', APPROVE, { stepRunId: gateId, comment: 'escalating' }),
  callAction(ownerA, 'owner', APPROVE, { stepRunId: gateId, comment: 'also escalating' }),
]);

check('concurrent approvals produce one success', race.filter((r) => r.status !== undefined).length === 1, `successes=${race.filter((r) => r.status !== undefined).length}`);
check('the loser gets a clean conflict', race.filter((r) => r.errorCode === 'conflict').length === 1, `conflicts=${race.filter((r) => r.errorCode === 'conflict').length}`);

const resumed = await snapshot(runId);
check('approval resumes the run to completion', resumed.status === 'succeeded', `status=${resumed.status}`);
check(
  'every step from the gate onward ran',
  resumed.step_runs.filter((step) => step.step_order >= 3).every((step) => step.status === 'succeeded'),
  layout(resumed),
);
check('approver recorded on the gate', gateOf(resumed)?.approved_by !== null, `approved_by=${String(gateOf(resumed)?.approved_by).slice(0, 8)}`);
check('approval comment stored', (gateOf(resumed)?.approval_comment ?? '').length > 0, `comment=${gateOf(resumed)?.approval_comment}`);
check('resume point cleared', resumed.resume_from_step_order === null, `resume_from=${resumed.resume_from_step_order}`);

// --- config narrows its own approvers ------------------------------------------------
// allowed_roles is per-step data, which is exactly why a static permission cannot
// express this rule.
const ownerOnlyId = await createGatedWorkflow(`${PROBE_PREFIX} approval owner only`, ['owner']);
await callAction(ownerA, 'owner', TRIGGER, {
  id: ownerOnlyId,
  payload: { text: 'urgent outage, customers are losing orders' },
});
const ownerOnlyGate = gateOf(await snapshot(await latestRunId(ownerOnlyId)));

const editorOnOwnerOnly = await callAction(editorA, 'editor', APPROVE, {
  stepRunId: ownerOnlyGate?.id ?? '',
  comment: null,
});
check('editor refused when gate allows owner only', editorOnOwnerOnly.errorCode === 'forbidden', `code=${editorOnOwnerOnly.errorCode ?? editorOnOwnerOnly.status}`);

const ownerOnOwnerOnly = await callAction(ownerA, 'owner', APPROVE, {
  stepRunId: ownerOnlyGate?.id ?? '',
  comment: 'owner approval',
});
check('owner clears the owner-only gate', ownerOnOwnerOnly.status === 'succeeded', `status=${ownerOnOwnerOnly.status ?? ownerOnOwnerOnly.errorMessage}`);

// --- approving something that is not a gate ------------------------------------------
const nonGate = resumed.step_runs.find((step) => step.step_order === 1);
const nonGateApproval = await callAction(ownerA, 'owner', APPROVE, {
  stepRunId: nonGate?.id ?? '',
  comment: null,
});
check('approving a non-gate step is refused', nonGateApproval.errorCode === 'conflict', `code=${nonGateApproval.errorCode ?? nonGateApproval.status}`);

// --- the NORMAL path skips the gate entirely -----------------------------------------
const normalId = await createGatedWorkflow(`${PROBE_PREFIX} approval normal path`);
const normal = await callAction(ownerA, 'owner', TRIGGER, {
  id: normalId,
  payload: { text: 'just checking in on the roadmap for next quarter' },
});
check('non-urgent payload never pauses', normal.status === 'succeeded', `status=${normal.status ?? normal.errorMessage}`);

const normalRun = await snapshot(await latestRunId(normalId));
check(
  'branch marks bypassed gate and request skipped',
  normalRun.step_runs.find((step) => step.step_order === 3)?.status === 'skipped' &&
    normalRun.step_runs.find((step) => step.step_order === 4)?.status === 'skipped',
  layout(normalRun),
);
check(
  'branch records the operand it evaluated',
  typeof normalRun.step_runs.find((step) => step.step_order === 2)?.output?.evaluated_left === 'string',
  `left=${JSON.stringify(normalRun.step_runs.find((step) => step.step_order === 2)?.output?.evaluated_left)}`,
);

await adminRequest(
  `mutation Cleanup($workflowIds: [uuid!]!) {
     delete_workflows(where: { id: { _in: $workflowIds } }) { affected_rows }
   }`,
  { workflowIds: createdWorkflowIds },
);

report();
