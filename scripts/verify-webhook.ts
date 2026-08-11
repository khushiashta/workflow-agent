/**
 * Webhook trigger probes: token minting, unauthenticated entry, rotation, and the
 * refusals.
 *
 * The webhook is the one entry point with no session behind it, so its token is the
 * whole of authorization. These probes exist to show that the token is actually checked,
 * that the stored hash is not itself a credential, and that quota still applies — an
 * unauthenticated endpoint exempt from quota would be a free amplifier.
 *
 *   npm run verify:webhook
 */

import { adminRequest, createReporter, getToken, requireEnv, roleRequest } from './_lib/api.ts';

const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');
const ORG_A_ID = '11111111-1111-1111-1111-111111111111';

const CREATE_WEBHOOK_TRIGGER = `
  mutation CreateWebhookTrigger($workflowId: uuid!) {
    createWebhookTrigger(workflow_id: $workflowId) { workflow_trigger_id token }
  }
`;

const START_VIA_WEBHOOK = `
  mutation StartViaWebhook($workflowId: uuid!, $token: String!, $payload: jsonb) {
    startWorkflowRunViaWebhook(workflow_id: $workflowId, token: $token, payload: $payload) {
      workflow_run_id
      status
    }
  }
`;

type WebhookOutcome = {
  runId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
};

/** Deliberately sends no Authorization header — this is the external-caller path. */
async function callAnonymously(
  workflowId: string,
  token: string,
  payload: unknown,
): Promise<WebhookOutcome> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: START_VIA_WEBHOOK,
      variables: { workflowId, token, payload },
    }),
  });

  const text = await response.text();
  if (!text) return { errorMessage: `empty body (HTTP ${response.status})` };

  const body = JSON.parse(text) as {
    data?: { startWorkflowRunViaWebhook?: { workflow_run_id: string; status: string } };
    errors?: { message: string; extensions?: { code?: string } }[];
  };

  if (body.errors?.length) {
    const first = body.errors[0];
    return { errorCode: first?.extensions?.code, errorMessage: first?.message };
  }
  return {
    runId: body.data?.startWorkflowRunViaWebhook?.workflow_run_id,
    status: body.data?.startWorkflowRunViaWebhook?.status,
  };
}

const createdWorkflowIds: string[] = [];
const createdOrgIds: string[] = [];

async function createWorkflow(orgId: string, name: string): Promise<string> {
  const data = await adminRequest<{ insert_workflows_one: { id: string } }>(
    `mutation CreateWorkflow($object: workflows_insert_input!) {
       insert_workflows_one(object: $object) { id }
     }`,
    {
      object: {
        org_id: orgId,
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
              step_type: 'db_write',
              name: 'record',
              config: { label: 'webhook_probe', payload: { verdict: '{{steps.1.output.text}}' } },
            },
          ],
        },
      },
    },
  );
  createdWorkflowIds.push(data.insert_workflows_one.id);
  return data.insert_workflows_one.id;
}

async function mintToken(token: string, role: string, workflowId: string) {
  const response = await roleRequest(token, role, CREATE_WEBHOOK_TRIGGER, { workflowId });
  if (response.errorCode || response.errorMessage) {
    return { errorCode: response.errorCode, errorMessage: response.errorMessage };
  }
  const result = response.data?.createWebhookTrigger as
    | { workflow_trigger_id: string; token: string }
    | undefined;
  return { triggerId: result?.workflow_trigger_id, token: result?.token };
}

const { check, report } = createReporter(56);

const ownerA = await getToken('owner-a@example.com');
const editorA = await getToken('editor-a@example.com');
const ownerB = await getToken('owner-b@example.com');

const workflowId = await createWorkflow(ORG_A_ID, 'webhook probe');

// --- minting is owner-only -----------------------------------------------------------
const editorMint = await mintToken(editorA, 'editor', workflowId);
check(
  'editor cannot mint a webhook token',
  editorMint.errorCode !== undefined && editorMint.token === undefined,
  `code=${editorMint.errorCode}`,
);

// An Org B owner naming a real Org A workflow must not learn it exists.
const orgBMint = await mintToken(ownerB, 'owner', workflowId);
check('Org B owner cannot mint for Org A', orgBMint.errorCode === 'not-found', `code=${orgBMint.errorCode}`);

const minted = await mintToken(ownerA, 'owner', workflowId);
check('owner mints a token', typeof minted.token === 'string' && (minted.token?.length ?? 0) > 30, `len=${minted.token?.length}`);

const webhookToken = minted.token ?? '';

// --- the stored hash must not be readable --------------------------------------------
const hashProbe = await roleRequest(
  ownerA,
  'owner',
  `query Trigger($workflowId: uuid!) {
     workflow_triggers(where: { workflow_id: { _eq: $workflowId } }) { id webhook_secret_hash }
   }`,
  { workflowId },
);
check(
  'webhook_secret_hash is not selectable by any role',
  hashProbe.errorCode !== undefined || hashProbe.errorMessage !== undefined,
  `msg=${(hashProbe.errorMessage ?? 'readable!').slice(0, 48)}`,
);

const storedHash = await adminRequest<{ workflow_triggers: { webhook_secret_hash: string }[] }>(
  `query Hash($workflowId: uuid!) {
     workflow_triggers(where: { workflow_id: { _eq: $workflowId }, trigger_type: { _eq: "webhook" } }) {
       webhook_secret_hash
     }
   }`,
  { workflowId },
).then((data) => data.workflow_triggers[0]?.webhook_secret_hash ?? '');

check('the plaintext token is not what is stored', storedHash !== webhookToken && storedHash.length === 64, `stored=${storedHash.slice(0, 12)}...`);

// --- unauthenticated entry -----------------------------------------------------------
const wrongToken = await callAnonymously(workflowId, 'not-the-token', { text: 'anything' });
check('wrong token is refused', wrongToken.errorCode === 'forbidden', `code=${wrongToken.errorCode} msg=${(wrongToken.errorMessage ?? '').slice(0, 30)}`);

const emptyToken = await callAnonymously(workflowId, '', { text: 'anything' });
check('empty token is refused', emptyToken.errorCode === 'forbidden', `code=${emptyToken.errorCode}`);

const unknownWorkflow = await callAnonymously(
  '99999999-9999-9999-9999-999999999999',
  webhookToken,
  {},
);
check('unknown workflow is not-found', unknownWorkflow.errorCode === 'not-found', `code=${unknownWorkflow.errorCode}`);

const accepted = await callAnonymously(workflowId, webhookToken, {
  text: 'just checking in on the roadmap',
});
check('valid token starts a run with no session', accepted.status === 'succeeded', `status=${accepted.status ?? accepted.errorMessage}`);

if (accepted.runId) {
  const run = await adminRequest<{
    workflow_runs_by_pk: { trigger_type: string; triggered_by: string | null; context: Record<string, unknown> };
  }>(
    `query Run($runId: uuid!) {
       workflow_runs_by_pk(id: $runId) { trigger_type triggered_by context }
     }`,
    { runId: accepted.runId },
  ).then((data) => data.workflow_runs_by_pk);

  check('run is recorded as webhook-triggered', run.trigger_type === 'webhook', `trigger_type=${run.trigger_type}`);
  check('no user is attributed to it', run.triggered_by === null, `triggered_by=${String(run.triggered_by)}`);

  const trigger = run.context.trigger as { payload?: { text?: string } } | undefined;
  check(
    'the caller payload reaches the run context',
    trigger?.payload?.text === 'just checking in on the roadmap',
    `payload.text=${JSON.stringify(trigger?.payload?.text)}`,
  );
}

// --- rotation ------------------------------------------------------------------------
const rotated = await mintToken(ownerA, 'owner', workflowId);
check('rotation issues a different token', rotated.token !== webhookToken, `changed=${String(rotated.token !== webhookToken)}`);

const oldTokenAfterRotation = await callAnonymously(workflowId, webhookToken, { text: 'roadmap' });
check('the old token stops working', oldTokenAfterRotation.errorCode === 'forbidden', `code=${oldTokenAfterRotation.errorCode}`);

const newTokenAfterRotation = await callAnonymously(workflowId, rotated.token ?? '', { text: 'roadmap' });
check('the new token works', newTokenAfterRotation.status === 'succeeded', `status=${newTokenAfterRotation.status ?? newTokenAfterRotation.errorMessage}`);

// --- quota still applies without a session -------------------------------------------
const quotaOrg = await adminRequest<{ insert_organizations_one: { id: string } }>(
  `mutation CreateOrg($object: organizations_insert_input!) {
     insert_organizations_one(object: $object) { id }
   }`,
  { object: { name: 'Webhook quota org', slug: `webhook-quota-${Date.now()}`, quota_calls_allowed: 1 } },
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

const quotaWorkflowId = await createWorkflow(quotaOrgId, 'webhook quota probe');
const quotaToken = (await mintToken(ownerA, 'owner', quotaWorkflowId)).token ?? '';

const firstWebhookRun = await callAnonymously(quotaWorkflowId, quotaToken, { text: 'roadmap' });
check('first webhook run within quota succeeds', firstWebhookRun.status === 'succeeded', `status=${firstWebhookRun.status ?? firstWebhookRun.errorMessage}`);

const refusedWebhookRun = await callAnonymously(quotaWorkflowId, quotaToken, { text: 'roadmap' });
check('exhausted quota refuses the webhook too', refusedWebhookRun.errorCode === 'quota-exhausted', `code=${refusedWebhookRun.errorCode ?? refusedWebhookRun.status}`);

await adminRequest(
  `mutation Cleanup($workflowIds: [uuid!]!, $orgIds: [uuid!]!) {
     delete_workflows(where: { id: { _in: $workflowIds } }) { affected_rows }
     delete_organizations(where: { id: { _in: $orgIds } }) { affected_rows }
   }`,
  { workflowIds: createdWorkflowIds, orgIds: createdOrgIds },
);

report();
