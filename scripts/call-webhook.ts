/**
 * Calls the inbound webhook Action the way an external system would — no session, no
 * Authorization header, just the per-trigger token.
 *
 *   npm run webhook -- <workflow-id> <token> [message]
 *   ENV_FILE=.env.cloud npm run webhook -- <workflow-id> <token> "checkout is broken"
 *
 * Exists because the equivalent curl is a paste-and-quote minefield: multi-line JSON in a
 * shell, an env var that has to be exported first, and a workflow id that is easy to
 * confuse with the page URL it appears in.
 */

import { requireEnv } from './_lib/api.ts';

const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');

const [workflowIdArg, token, ...messageParts] = process.argv.slice(2);
const message = messageParts.join(' ') || 'just checking in on the roadmap';

if (!workflowIdArg || !token) {
  console.error('Usage: npm run webhook -- <workflow-id> <token> [message]');
  process.exit(1);
}

// Accept a pasted page URL as well as a bare id — the id is the last path segment of
// /workflows/<id>, and pasting the whole URL is the obvious mistake to make.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const workflowId = workflowIdArg.match(UUID)?.[0];

if (!workflowId) {
  console.error(`Could not find a workflow id in "${workflowIdArg}".`);
  console.error('Pass the id itself, or the /workflows/<id> URL it appears in.');
  process.exit(1);
}

const MUTATION = `
  mutation StartViaWebhook($id: uuid!, $token: String!, $payload: jsonb) {
    startWorkflowRunViaWebhook(workflow_id: $id, token: $token, payload: $payload) {
      workflow_run_id
      status
    }
  }
`;

const response = await fetch(graphqlUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    query: MUTATION,
    variables: { id: workflowId, token, payload: { text: message } },
  }),
});

const body = (await response.json()) as {
  data?: { startWorkflowRunViaWebhook?: { workflow_run_id: string; status: string } };
  errors?: { message: string; extensions?: { code?: string } }[];
};

if (body.errors?.length) {
  const first = body.errors[0];
  console.error(`Refused (${first?.extensions?.code ?? 'error'}): ${first?.message}`);
  process.exit(1);
}

const result = body.data?.startWorkflowRunViaWebhook;
console.log(`\nStarted a run with no session.\n`);
console.log(`  message  ${message}`);
console.log(`  status   ${result?.status}`);
console.log(`  run      ${result?.workflow_run_id}\n`);
console.log(`Watch it at /runs/${result?.workflow_run_id}\n`);
