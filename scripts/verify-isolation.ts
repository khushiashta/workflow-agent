/**
 * Cross-org isolation probes.
 *
 * Runs every read an Org B user could attempt against Org A's real ids, plus positive
 * controls from inside Org A. The controls matter: a suite where everything returns
 * nothing passes the negative probes for the wrong reason, and looks identical to one
 * where the rules actually work.
 *
 * A permission *error* counts as a failure even though it denies access — an error
 * confirms the row exists. `null` and `[]` are the answers that reveal nothing.
 *
 *   npm run verify:isolation
 */

const authUrl = requireEnv('NHOST_AUTH_URL');
const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');
const password = requireEnv('SEED_USER_PASSWORD');

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B_ID = '22222222-2222-2222-2222-222222222222';
const WORKFLOW_ID = '33333333-3333-3333-3333-333333333333';
const STEP_ID = 'aaaaaaaa-0000-0000-0000-000000000003';

type Role = 'owner' | 'editor' | 'viewer';
type Expectation = 'empty' | 'present';

type Probe = {
  label: string;
  query: string;
  pick: (data: Record<string, unknown>) => unknown;
};

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

async function query(token: string, role: Role, gql: string) {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-hasura-role': role,
    },
    body: JSON.stringify({ query: gql }),
  });
  return (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: { message: string }[];
  };
}

const PROBES: Probe[] = [
  {
    label: 'organizations_by_pk',
    query: `{ organizations_by_pk(id: "${ORG_A_ID}") { id name } }`,
    pick: (d) => d.organizations_by_pk,
  },
  {
    label: 'workflows_by_pk',
    query: `{ workflows_by_pk(id: "${WORKFLOW_ID}") { id name } }`,
    pick: (d) => d.workflows_by_pk,
  },
  {
    label: 'workflow_steps',
    query: `{ workflow_steps(where: {workflow_id: {_eq: "${WORKFLOW_ID}"}}) { id step_type } }`,
    pick: (d) => d.workflow_steps,
  },
  {
    label: 'workflow_steps_by_pk',
    query: `{ workflow_steps_by_pk(id: "${STEP_ID}") { id step_type config } }`,
    pick: (d) => d.workflow_steps_by_pk,
  },
  {
    label: 'workflow_triggers',
    query: `{ workflow_triggers(where: {workflow_id: {_eq: "${WORKFLOW_ID}"}}) { id trigger_type } }`,
    pick: (d) => d.workflow_triggers,
  },
  {
    label: 'workflow_runs',
    query: `{ workflow_runs(where: {workflow_id: {_eq: "${WORKFLOW_ID}"}}) { id status } }`,
    pick: (d) => d.workflow_runs,
  },
  {
    label: 'step_runs',
    query: `{ step_runs(where: {workflow_run: {workflow_id: {_eq: "${WORKFLOW_ID}"}}}) { id status } }`,
    pick: (d) => d.step_runs,
  },
  {
    label: 'org_members',
    query: `{ org_members(where: {org_id: {_eq: "${ORG_A_ID}"}}) { user_id role } }`,
    pick: (d) => d.org_members,
  },
  {
    label: 'org_usage_summary',
    query: `{ org_usage_summary(where: {org_id: {_eq: "${ORG_A_ID}"}}) { quota_calls_used } }`,
    pick: (d) => d.org_usage_summary,
  },
  {
    label: 'step_outputs',
    query: `{ step_outputs(where: {org_id: {_eq: "${ORG_A_ID}"}}) { id label } }`,
    pick: (d) => d.step_outputs,
  },
  {
    label: 'aggregate count',
    query: `{ workflows_aggregate(where: {org_id: {_eq: "${ORG_A_ID}"}}) { aggregate { count } } }`,
    pick: (d) => {
      const agg = d.workflows_aggregate as { aggregate?: { count?: number } } | undefined;
      return agg?.aggregate?.count === 0 ? null : agg;
    },
  },
  {
    label: 'auth users in Org A',
    query: `{ users(where: {org_memberships: {org_id: {_eq: "${ORG_A_ID}"}}}) { id email } }`,
    pick: (d) => d.users,
  },
];

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return Array.isArray(value) && value.length === 0;
}

const results: { ok: boolean; line: string }[] = [];

function record(scenario: string, probe: string, expect: Expectation, outcome: string, ok: boolean) {
  results.push({
    ok,
    line: `${ok ? 'PASS' : 'FAIL'}  ${scenario.padEnd(28)} ${probe.padEnd(24)} expect ${expect.padEnd(7)} got ${outcome}`,
  });
}

async function run(scenario: string, token: string, role: Role, expect: Expectation) {
  for (const probe of PROBES) {
    const response = await query(token, role, probe.query);

    if (response.errors?.length) {
      // Denies access, but confirms the resource exists. Not good enough.
      record(scenario, probe.label, expect, `error: ${response.errors[0]?.message}`, false);
      continue;
    }

    const value = probe.pick(response.data ?? {});
    const empty = isEmpty(value);
    const outcome = empty ? 'empty' : 'data';
    record(scenario, probe.label, expect, outcome, expect === 'empty' ? empty : !empty);
  }
}

const ownerB = await signIn('owner-b@example.com');
const ownerA = await signIn('owner-a@example.com');
const viewerA = await signIn('viewer-a@example.com');

// Negative: Org B holds every real Org A id and still sees nothing, under each role it
// could put in the header. Claiming a role it does not hold changes which permission set
// applies, not which rows exist for it.
await run('OrgB owner -> OrgA', ownerB, 'owner', 'empty');
await run('OrgB as editor -> OrgA', ownerB, 'editor', 'empty');
await run('OrgB as viewer -> OrgA', ownerB, 'viewer', 'empty');

// Positive: the same probes from inside Org A must return data, or the negatives above
// prove nothing.
await run('OrgA owner -> OrgA', ownerA, 'owner', 'present');
await run('OrgA viewer -> OrgA', viewerA, 'viewer', 'present');

// An Org A member claiming a role they do not hold gets that permission set and no rows.
await run('OrgA viewer as owner', viewerA, 'owner', 'empty');

for (const result of results) console.log(result.line);

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
