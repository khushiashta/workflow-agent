/**
 * Puts a backend into a known state for a live walkthrough, and records the two values the
 * webhook call needs so they never have to be typed again.
 *
 *   ENV_FILE=.env.cloud npm run demo:prepare
 *
 * Resets quota usage, rebuilds the demo workflow with all five step types, mints a fresh
 * webhook token, and writes DEMO_WORKFLOW_ID and DEMO_WEBHOOK_TOKEN into the env file in
 * use — so `npm run webhook -- "some message"` needs no ids or tokens pasted in.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { adminRequest, requireEnv } from './_lib/api.ts';

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B_ID = '22222222-2222-2222-2222-222222222222';
const DEMO_WORKFLOW_ID = '55555555-5555-5555-5555-555555555555';

const envFile = process.env.ENV_FILE ?? '.env';
requireEnv('NHOST_GRAPHQL_URL');

const STEPS = [
  {
    step_order: 1,
    step_type: 'llm_call',
    name: 'Classify urgency',
    config: {
      prompt: 'Reply with exactly one word, URGENT or NORMAL. Message: {{trigger.payload.text}}',
      temperature: 0,
      max_tokens: 8,
    },
  },
  {
    step_order: 2,
    step_type: 'conditional_branch',
    name: 'Urgent?',
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
    name: 'Approve escalation',
    config: {
      instructions: 'Confirm this should be escalated before notifying the customer',
      allowed_roles: ['owner', 'editor'],
    },
  },
  {
    step_order: 4,
    step_type: 'http_request',
    name: 'Notify escalation endpoint',
    config: { method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 },
  },
  {
    step_order: 5,
    step_type: 'db_write',
    name: 'Record verdict',
    config: { label: 'triage_verdict', payload: { verdict: '{{steps.1.output.text}}' } },
  },
// workflow_id is deliberately absent: these are inserted nested under the workflow, and
// Hasura sets it from the parent.
].map((step, index) => ({
  ...step,
  id: `eeeeeeee-0000-0000-0000-00000000000${index + 1}`,
}));

await adminRequest(
  `mutation ResetQuota($orgIds: [uuid!]!) {
     update_organizations(where: { id: { _in: $orgIds } }, _set: { quota_calls_used: 0 }) {
       affected_rows
     }
   }`,
  { orgIds: [ORG_A_ID, ORG_B_ID] },
);

// Rebuilt from scratch rather than upserted: previous runs, step runs and rotated tokens
// all hang off it, and a walkthrough wants a clean history.
await adminRequest(
  `mutation DropDemoWorkflow($id: uuid!) {
     delete_workflows(where: { id: { _eq: $id } }) { affected_rows }
   }`,
  { id: DEMO_WORKFLOW_ID },
);

const ownerId = await adminRequest<{ org_members: { user_id: string }[] }>(
  `query Owner($orgId: uuid!) {
     org_members(where: { org_id: { _eq: $orgId }, role: { _eq: "owner" } }, limit: 1) {
       user_id
     }
   }`,
  { orgId: ORG_A_ID },
).then((data) => data.org_members[0]?.user_id ?? null);

if (!ownerId) {
  throw new Error('Org A has no owner. Run `npm run seed` first.');
}

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token).digest('hex');

await adminRequest(
  `mutation CreateDemoWorkflow($object: workflows_insert_input!) {
     insert_workflows_one(object: $object) { id }
   }`,
  {
    object: {
      id: DEMO_WORKFLOW_ID,
      org_id: ORG_A_ID,
      name: 'Escalation triage',
      description: 'Classifies an inbound message and escalates urgent ones through an approval gate',
      created_by: ownerId,
      steps: { data: STEPS.map((step) => ({ ...step, created_by: ownerId })) },
      triggers: {
        data: [
          { trigger_type: 'manual', is_enabled: true, config: {}, created_by: ownerId },
          {
            trigger_type: 'webhook',
            is_enabled: true,
            config: {},
            webhook_secret_hash: hash,
            created_by: ownerId,
          },
        ],
      },
    },
  },
);

// Written into the env file so the webhook command carries no ids or tokens. Editing a long
// JSON payload by hand was the single most error-prone step of the walkthrough.
const contents = readFileSync(envFile, 'utf8');
const withoutDemo = contents
  .split('\n')
  .filter((line) => !/^DEMO_(WORKFLOW_ID|WEBHOOK_TOKEN)=/.test(line))
  .join('\n')
  .replace(/\n+$/, '\n');

writeFileSync(
  envFile,
  `${withoutDemo}\n# Written by npm run demo:prepare — the webhook script reads these.\nDEMO_WORKFLOW_ID=${DEMO_WORKFLOW_ID}\nDEMO_WEBHOOK_TOKEN=${token}\n`,
);

// Runnable files rather than lines to copy. Retyping a token is how curly quotes get in,
// and they are invisible until the shell fails on them.
const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');

const curlFor = (message: string, withToken = token) => {
  const body = JSON.stringify({
    query:
      'mutation($id:uuid!,$token:String!,$payload:jsonb){startWorkflowRunViaWebhook(workflow_id:$id,token:$token,payload:$payload){workflow_run_id status}}',
    variables: { id: DEMO_WORKFLOW_ID, token: withToken, payload: { text: message } },
  });
  return `curl -s ${graphqlUrl} -H 'content-type: application/json' -d '${body}'\n`;
};

mkdirSync('demo', { recursive: true });
writeFileSync('demo/webhook-normal.sh', curlFor('just checking in on the roadmap'));
writeFileSync(
  'demo/webhook-urgent.sh',
  curlFor('the checkout page is completely broken and we are losing orders'),
);
writeFileSync('demo/webhook-bad-token.sh', curlFor('test', 'wrong-token'));

const prefix = envFile === '.env' ? '' : `ENV_FILE=${envFile} `;

console.log(`\nReady to record. Quota reset, demo workflow rebuilt, webhook token minted.\n`);
console.log(`  workflow   ${DEMO_WORKFLOW_ID}`);
console.log(`  token      written to ${envFile} (not printed here)\n`);
console.log('Ready-to-run commands rewritten in demo/ :\n');
console.log('  sh demo/webhook-normal.sh       finishes, branch skips the gate');
console.log('  sh demo/webhook-urgent.sh       pauses at the approval gate');
console.log('  sh demo/webhook-bad-token.sh    refused\n');
console.log(`Or: ${prefix}npm run webhook -- "your message"\n`);
