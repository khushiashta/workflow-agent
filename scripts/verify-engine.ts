/**
 * Engine probes: execution, retry classification, the SSRF guard, and quota.
 *
 * Fixtures are created and torn down per run, so this is safe to re-run and safe to
 * point at the deployed backend.
 *
 *   npm run verify:engine
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

type StepInput = {
  step_order: number;
  step_type: string;
  name: string;
  config: Record<string, unknown>;
};

type StepRunSnapshot = {
  step_order: number;
  status: string;
  attempt_count: number;
  output: Record<string, unknown> | null;
  error: string | null;
};

type RunSnapshot = {
  status: string;
  error: string | null;
  step_runs: StepRunSnapshot[];
};

type TriggerResult = {
  runId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
};

async function trigger(
  token: string,
  role: string,
  workflowId: string,
  payload: unknown = {},
): Promise<TriggerResult> {
  const response = await roleRequest(
    token,
    role,
    `mutation Trigger($id: uuid!, $payload: jsonb) {
       triggerWorkflowRun(workflow_id: $id, payload: $payload) { workflow_run_id status }
     }`,
    { id: workflowId, payload },
  );

  if (response.errorCode || response.errorMessage) {
    return { errorCode: response.errorCode, errorMessage: response.errorMessage };
  }
  const result = response.data?.triggerWorkflowRun as
    | { workflow_run_id: string; status: string }
    | undefined;
  return { runId: result?.workflow_run_id, status: result?.status };
}

const RUN_SNAPSHOT = `
  query RunSnapshot($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      status
      error
      step_runs(order_by: { step_order: asc }) {
        step_order
        status
        attempt_count
        output
        error
      }
    }
  }
`;

const snapshot = async (runId: string): Promise<RunSnapshot> => {
  const data = await adminRequest<{ workflow_runs_by_pk: RunSnapshot }>(RUN_SNAPSHOT, { runId });
  return data.workflow_runs_by_pk;
};

const quotaUsed = async (orgId: string): Promise<number> => {
  const data = await adminRequest<{ organizations_by_pk: { quota_calls_used: number } }>(
    `query Quota($orgId: uuid!) { organizations_by_pk(id: $orgId) { quota_calls_used } }`,
    { orgId },
  );
  return data.organizations_by_pk.quota_calls_used;
};

const createdWorkflowIds: string[] = [];
const createdOrgIds: string[] = [];

async function createWorkflow(orgId: string, name: string, steps: StepInput[]): Promise<string> {
  const data = await adminRequest<{ insert_workflows_one: { id: string } }>(
    `mutation CreateWorkflow($object: workflows_insert_input!) {
       insert_workflows_one(object: $object) { id }
     }`,
    { object: { org_id: orgId, name, steps: { data: steps } } },
  );
  createdWorkflowIds.push(data.insert_workflows_one.id);
  return data.insert_workflows_one.id;
}

const httpStep = (config: Record<string, unknown>): StepInput => ({
  step_order: 1,
  step_type: 'http_request',
  name: 'probe request',
  config,
});

const { check, report } = createReporter(56);

await sweepProbeFixtures();

const ownerA = await getToken('owner-a@example.com');
const viewerA = await getToken('viewer-a@example.com');
const ownerB = await getToken('owner-b@example.com');

// --- happy path: llm_call then http_request -----------------------------------------
const happyId = await createWorkflow(ORG_A_ID, `${PROBE_PREFIX} llm then http`, [
  {
    step_order: 1,
    step_type: 'llm_call',
    name: 'classify',
    config: {
      prompt: 'Reply with exactly one word, URGENT or NORMAL. Message: {{trigger.payload.text}}',
      temperature: 0,
      max_tokens: 8,
    },
  },
  {
    step_order: 2,
    step_type: 'http_request',
    name: 'fetch zen',
    config: { method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 },
  },
]);

const quotaBefore = await quotaUsed(ORG_A_ID);
const happy = await trigger(ownerA, 'owner', happyId, {
  text: 'the checkout page is completely broken and we are losing orders',
});
check('two-step run reaches succeeded', happy.status === 'succeeded', `status=${happy.status ?? happy.errorMessage}`);

if (happy.runId) {
  const run = await snapshot(happy.runId);
  const llm = run.step_runs.find((step) => step.step_order === 1);
  const http = run.step_runs.find((step) => step.step_order === 2);

  const llmText = typeof llm?.output?.text === 'string' ? llm.output.text : '';
  check('llm_call produced text', llmText.length > 0, `text=${JSON.stringify(llmText)}`);
  check(
    'llm_call used the real API (not the stub)',
    llm?.output?.stubbed === false,
    `stubbed=${String(llm?.output?.stubbed)}`,
  );
  check('http_request returned 200', http?.output?.status === 200, `status=${String(http?.output?.status)}`);
  check('successful steps used one attempt', llm?.attempt_count === 1 && http?.attempt_count === 1, `${llm?.attempt_count}/${http?.attempt_count}`);
}

const quotaAfter = await quotaUsed(ORG_A_ID);
check('completion consumed exactly one quota call', quotaAfter === quotaBefore + 1, `${quotaBefore} -> ${quotaAfter}`);

// --- authorization ------------------------------------------------------------------
// The action is not exposed to `viewer` at all, so Hasura rejects at schema validation
// and the request never reaches the handler.
const asViewer = await trigger(viewerA, 'viewer', happyId);
check(
  'viewer cannot reach the action',
  asViewer.errorCode === 'validation-failed' || asViewer.errorCode === 'forbidden',
  `code=${asViewer.errorCode ?? asViewer.status}`,
);

// The probe that matters: every JWT carries all three roles as allowed, so a viewer can
// simply claim `editor` and get past the action permission. Only the handler's lookup of
// their actual membership stops them — which is why that check cannot live in Hasura.
const viewerClaimingEditor = await trigger(viewerA, 'editor', happyId);
check(
  'viewer claiming editor is refused by the handler',
  viewerClaimingEditor.errorCode === 'forbidden',
  `code=${viewerClaimingEditor.errorCode ?? viewerClaimingEditor.status} msg=${(viewerClaimingEditor.errorMessage ?? '').slice(0, 40)}`,
);

// An Org B owner holding a real Org A workflow id must not learn that it exists.
const asOrgB = await trigger(ownerB, 'owner', happyId);
check('Org B gets not-found, never forbidden', asOrgB.errorCode === 'not-found', `code=${asOrgB.errorCode ?? asOrgB.status}`);

// --- retry classification -----------------------------------------------------------
// A connection timeout is transient by definition, so it earns the second attempt.
const transientId = await createWorkflow(ORG_A_ID, `${PROBE_PREFIX} transient failure`, [
  httpStep({ method: 'GET', url: 'https://example.com:81/', timeout_ms: 1500 }),
]);
const transient = await trigger(ownerA, 'owner', transientId);
const transientRun = transient.runId ? await snapshot(transient.runId) : null;
check('transient failure fails the run', transientRun?.status === 'failed', `status=${transientRun?.status}`);
check(
  'transient failure retried once (2 attempts)',
  transientRun?.step_runs[0]?.attempt_count === 2,
  `attempts=${transientRun?.step_runs[0]?.attempt_count}`,
);

// A 404 is the request being wrong. Retrying reproduces it and bills for it again.
const permanentId = await createWorkflow(ORG_A_ID, `${PROBE_PREFIX} permanent failure`, [
  httpStep({ method: 'GET', url: 'https://api.github.com/nope-does-not-exist', timeout_ms: 10000 }),
]);
const permanent = await trigger(ownerA, 'owner', permanentId);
const permanentRun = permanent.runId ? await snapshot(permanent.runId) : null;
check('permanent failure fails the run', permanentRun?.status === 'failed', `status=${permanentRun?.status}`);
check(
  'permanent failure NOT retried (1 attempt)',
  permanentRun?.step_runs[0]?.attempt_count === 1,
  `attempts=${permanentRun?.step_runs[0]?.attempt_count}`,
);

// --- SSRF guard ---------------------------------------------------------------------
const ssrfId = await createWorkflow(ORG_A_ID, `${PROBE_PREFIX} ssrf`, [
  httpStep({ method: 'GET', url: 'http://169.254.169.254/latest/meta-data/', timeout_ms: 5000 }),
]);
const ssrf = await trigger(ownerA, 'owner', ssrfId);
const ssrfRun = ssrf.runId ? await snapshot(ssrf.runId) : null;
check('link-local metadata address is refused', ssrfRun?.status === 'failed', `status=${ssrfRun?.status}`);
check(
  'refusal names the internal-address rule',
  (ssrfRun?.step_runs[0]?.error ?? '').includes('internal addresses'),
  `error=${(ssrfRun?.step_runs[0]?.error ?? '').slice(0, 60)}`,
);
check(
  'blocked request is not retried',
  ssrfRun?.step_runs[0]?.attempt_count === 1,
  `attempts=${ssrfRun?.step_runs[0]?.attempt_count}`,
);

// --- quota ---------------------------------------------------------------------------
const quotaOrg = await adminRequest<{ insert_organizations_one: { id: string } }>(
  `mutation CreateOrg($object: organizations_insert_input!) {
     insert_organizations_one(object: $object) { id }
   }`,
  {
    object: {
      name: 'Probe quota org',
      slug: `probe-quota-${Date.now()}`,
      quota_calls_allowed: 1,
    },
  },
);
const quotaOrgId = quotaOrg.insert_organizations_one.id;
createdOrgIds.push(quotaOrgId);

const ownerAId = await adminRequest<{ org_members: { user_id: string }[] }>(
  `query OwnerA($orgId: uuid!) {
     org_members(where: { org_id: { _eq: $orgId }, role: { _eq: "owner" } }) { user_id }
   }`,
  { orgId: ORG_A_ID },
).then((data) => data.org_members[0]?.user_id);

await adminRequest(
  `mutation AddMember($object: org_members_insert_input!) {
     insert_org_members_one(object: $object) { id }
   }`,
  { object: { org_id: quotaOrgId, user_id: ownerAId, role: 'owner' } },
);

const quotaWorkflowId = await createWorkflow(quotaOrgId, `${PROBE_PREFIX} quota`, [
  httpStep({ method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 }),
]);
const failingWorkflowId = await createWorkflow(quotaOrgId, `${PROBE_PREFIX} quota failure`, [
  httpStep({ method: 'GET', url: 'https://api.github.com/nope-does-not-exist', timeout_ms: 10000 }),
]);

const failedRun = await trigger(ownerA, 'owner', failingWorkflowId);
check(
  'a failed run consumes no quota',
  (await quotaUsed(quotaOrgId)) === 0,
  `used=${await quotaUsed(quotaOrgId)} after status=${(failedRun.runId ? await snapshot(failedRun.runId) : null)?.status}`,
);

const firstQuotaRun = await trigger(ownerA, 'owner', quotaWorkflowId);
check('first run within quota succeeds', firstQuotaRun.status === 'succeeded', `status=${firstQuotaRun.status ?? firstQuotaRun.errorMessage}`);

const runsBeforeRefusal = await adminRequest<{ workflow_runs_aggregate: { aggregate: { count: number } } }>(
  `query CountRuns($orgId: uuid!) {
     workflow_runs_aggregate(where: { org_id: { _eq: $orgId } }) { aggregate { count } }
   }`,
  { orgId: quotaOrgId },
).then((data) => data.workflow_runs_aggregate.aggregate.count);

const refused = await trigger(ownerA, 'owner', quotaWorkflowId);
check('exhausted quota refuses the run', refused.errorCode === 'quota-exhausted', `code=${refused.errorCode ?? refused.status}`);

const runsAfterRefusal = await adminRequest<{ workflow_runs_aggregate: { aggregate: { count: number } } }>(
  `query CountRuns($orgId: uuid!) {
     workflow_runs_aggregate(where: { org_id: { _eq: $orgId } }) { aggregate { count } }
   }`,
  { orgId: quotaOrgId },
).then((data) => data.workflow_runs_aggregate.aggregate.count);

// Refused before the row exists, so an exhausted org does not accumulate dead runs.
check('refusal creates no run row', runsAfterRefusal === runsBeforeRefusal, `${runsBeforeRefusal} -> ${runsAfterRefusal}`);

await adminRequest(
  `mutation Cleanup($workflowIds: [uuid!]!, $orgIds: [uuid!]!) {
     delete_workflows(where: { id: { _in: $workflowIds } }) { affected_rows }
     delete_organizations(where: { id: { _in: $orgIds } }) { affected_rows }
   }`,
  { workflowIds: createdWorkflowIds, orgIds: createdOrgIds },
);

report();
