/**
 * Layer 2 probes: only an owner may author a db_write or notify step, or a webhook
 * trigger.
 *
 * The retype probe is the one that matters. A type restriction expressed only as an
 * update `filter` stops an editor editing an existing privileged step but still lets
 * them select a permitted step and change its step_type into a privileged one. The gate
 * has to appear in the `check` as well, and only a probe that attempts the retype
 * distinguishes the two.
 *
 *   npm run verify:gating
 */

const authUrl = requireEnv('NHOST_AUTH_URL');
const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');
const adminSecret = requireEnv('NHOST_ADMIN_SECRET');
const password = requireEnv('SEED_USER_PASSWORD');

const WORKFLOW_ID = '33333333-3333-3333-3333-333333333333';
const PROBE_STEP_ORDER_BASE = 900;

type Role = 'owner' | 'editor';
type Outcome = 'allowed' | 'denied';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

async function signIn(email: string): Promise<string> {
  const response = await fetch(`${authUrl}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`Sign-in failed for ${email}: ${await response.text()}`);
  const body = (await response.json()) as { session?: { accessToken?: string } };
  const token = body.session?.accessToken;
  if (!token) throw new Error(`No access token for ${email}`);
  return token;
}

type MutationResult = { outcome: Outcome; detail: string; id?: string };

async function mutate(
  token: string,
  role: Role,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<MutationResult> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-hasura-role': role,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    return { outcome: 'denied', detail: body.errors[0]?.message.slice(0, 60) ?? 'error' };
  }

  // A failing insert `check` errors, but a row excluded by an update or delete `filter`
  // simply matches nothing. Both are refusals.
  const root = Object.values(body.data ?? {})[0] as
    | { affected_rows?: number; id?: string }
    | null
    | undefined;

  if (root === null || root === undefined) return { outcome: 'denied', detail: 'null result' };
  if (typeof root.affected_rows === 'number') {
    return root.affected_rows > 0
      ? { outcome: 'allowed', detail: `${root.affected_rows} rows` }
      : { outcome: 'denied', detail: '0 rows' };
  }
  return { outcome: 'allowed', detail: 'created', id: root.id };
}

async function adminMutate(query: string, variables: Record<string, unknown> = {}) {
  await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': adminSecret },
    body: JSON.stringify({ query, variables }),
  });
}

const INSERT_STEP = `
  mutation InsertStep($object: workflow_steps_insert_input!) {
    insert_workflow_steps_one(object: $object) { id }
  }
`;

const RETYPE_STEP = `
  mutation RetypeStep($id: uuid!, $stepType: String!) {
    update_workflow_steps(where: {id: {_eq: $id}}, _set: {step_type: $stepType}) {
      affected_rows
    }
  }
`;

const DELETE_STEP = `
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps(where: {id: {_eq: $id}}) { affected_rows }
  }
`;

const INSERT_TRIGGER = `
  mutation InsertTrigger($object: workflow_triggers_insert_input!) {
    insert_workflow_triggers_one(object: $object) { id }
  }
`;

const results: { ok: boolean; line: string }[] = [];
const createdStepIds: string[] = [];
const createdTriggerIds: string[] = [];

function record(label: string, expected: Outcome, actual: MutationResult) {
  const ok = actual.outcome === expected;
  results.push({
    ok,
    line: `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} expect ${expected.padEnd(7)} got ${actual.outcome.padEnd(7)} (${actual.detail})`,
  });
}

const step = (order: number, stepType: string, name: string) => ({
  workflow_id: WORKFLOW_ID,
  step_order: PROBE_STEP_ORDER_BASE + order,
  step_type: stepType,
  name,
  config: {},
});

const ownerA = await signIn('owner-a@example.com');
const editorA = await signIn('editor-a@example.com');

// Positive control first: without it, a suite where every write fails looks like perfect
// gating.
const editorHttp = await mutate(editorA, 'editor', INSERT_STEP, {
  object: step(1, 'http_request', 'probe editor http_request'),
});
record('editor inserts http_request', 'allowed', editorHttp);
if (editorHttp.id) createdStepIds.push(editorHttp.id);

record(
  'editor inserts db_write',
  'denied',
  await mutate(editorA, 'editor', INSERT_STEP, { object: step(2, 'db_write', 'probe editor db_write') }),
);

record(
  'editor inserts notify',
  'denied',
  await mutate(editorA, 'editor', INSERT_STEP, { object: step(3, 'notify', 'probe editor notify') }),
);

// The retype hole: an update gate written only as a filter passes every probe above and
// fails this one.
if (editorHttp.id) {
  record(
    'editor retypes own http_request into db_write',
    'denied',
    await mutate(editorA, 'editor', RETYPE_STEP, { id: editorHttp.id, stepType: 'db_write' }),
  );
  record(
    'editor retypes own http_request into notify',
    'denied',
    await mutate(editorA, 'editor', RETYPE_STEP, { id: editorHttp.id, stepType: 'notify' }),
  );
  record(
    'editor renames own http_request step type to llm_call',
    'allowed',
    await mutate(editorA, 'editor', RETYPE_STEP, { id: editorHttp.id, stepType: 'llm_call' }),
  );
}

const ownerDbWrite = await mutate(ownerA, 'owner', INSERT_STEP, {
  object: step(4, 'db_write', 'probe owner db_write'),
});
record('owner inserts db_write', 'allowed', ownerDbWrite);
if (ownerDbWrite.id) createdStepIds.push(ownerDbWrite.id);

if (ownerDbWrite.id) {
  record(
    "editor deletes owner's db_write step",
    'denied',
    await mutate(editorA, 'editor', DELETE_STEP, { id: ownerDbWrite.id }),
  );
  record(
    "editor edits owner's db_write step",
    'denied',
    await mutate(editorA, 'editor', RETYPE_STEP, { id: ownerDbWrite.id, stepType: 'http_request' }),
  );
}

const editorWebhook = await mutate(editorA, 'editor', INSERT_TRIGGER, {
  object: { workflow_id: WORKFLOW_ID, trigger_type: 'webhook', is_enabled: true, config: {} },
});
record('editor inserts webhook trigger', 'denied', editorWebhook);
if (editorWebhook.id) createdTriggerIds.push(editorWebhook.id);

const editorScheduled = await mutate(editorA, 'editor', INSERT_TRIGGER, {
  object: { workflow_id: WORKFLOW_ID, trigger_type: 'scheduled', is_enabled: false, config: {} },
});
record('editor inserts scheduled trigger', 'allowed', editorScheduled);
if (editorScheduled.id) createdTriggerIds.push(editorScheduled.id);

const ownerWebhook = await mutate(ownerA, 'owner', INSERT_TRIGGER, {
  object: { workflow_id: WORKFLOW_ID, trigger_type: 'webhook', is_enabled: false, config: {} },
});
record('owner inserts webhook trigger', 'allowed', ownerWebhook);
if (ownerWebhook.id) createdTriggerIds.push(ownerWebhook.id);

await adminMutate(
  `mutation Cleanup($stepIds: [uuid!]!, $triggerIds: [uuid!]!) {
     delete_workflow_steps(where: {id: {_in: $stepIds}}) { affected_rows }
     delete_workflow_triggers(where: {id: {_in: $triggerIds}}) { affected_rows }
   }`,
  { stepIds: createdStepIds, triggerIds: createdTriggerIds },
);

for (const result of results) console.log(result.line);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
