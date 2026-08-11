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

import { createReporter, getToken, roleRequest } from './_lib/api.ts';

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const WORKFLOW_ID = '33333333-3333-3333-3333-333333333333';
const RUN_ID = '44444444-4444-4444-4444-444444444444';
const STEP_ID = 'aaaaaaaa-0000-0000-0000-000000000003';

type Role = 'owner' | 'editor' | 'viewer' | 'user';
type Expectation = 'empty' | 'present';

type Probe = {
  label: string;
  query: string;
  pick: (data: Record<string, unknown>) => unknown;
};

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
    label: 'workflow_runs_by_pk',
    query: `{ workflow_runs_by_pk(id: "${RUN_ID}") { id status } }`,
    pick: (d) => d.workflow_runs_by_pk,
  },
  {
    label: 'step_runs',
    query: `{ step_runs(where: {workflow_run_id: {_eq: "${RUN_ID}"}}) { id status output } }`,
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
    query: `{ step_outputs(where: {org_id: {_eq: "${ORG_A_ID}"}}) { id label payload } }`,
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

/**
 * A role with no permission on a table does not get that table in its GraphQL schema at
 * all, so Hasura answers "field not found in type query_root". That reveals nothing about
 * any particular row — it is true for every id, in every organization — which makes it a
 * stronger refusal than an empty result, not a weaker one.
 *
 * Every other error still counts as a failure: a row-level permission error confirms the
 * row exists, which is exactly the leak these probes are here to rule out.
 */
const isSchemaLevelRefusal = (message: string) =>
  /field '[^']+' not found in type: '(query_root|mutation_root)'/.test(message);

const { check, report } = createReporter(24);

async function run(scenario: string, token: string, role: Role, expect: Expectation) {
  for (const probe of PROBES) {
    const response = await roleRequest(token, role, probe.query);
    const label = `${scenario.padEnd(28)} ${probe.label}`;

    if (response.errorCode || response.errorMessage) {
      const message = response.errorMessage ?? '';
      if (expect === 'empty' && isSchemaLevelRefusal(message)) {
        check(label, true, 'expect empty   got not-in-schema');
        continue;
      }
      check(label, false, `expect ${expect} got error: ${message}`);
      continue;
    }

    const empty = isEmpty(probe.pick(response.data ?? {}));
    check(label, expect === 'empty' ? empty : !empty, `expect ${expect.padEnd(7)} got ${empty ? 'empty' : 'data'}`);
  }
}

const ownerB = await getToken('owner-b@example.com');
const ownerA = await getToken('owner-a@example.com');
const viewerA = await getToken('viewer-a@example.com');

// Negative: Org B holds every real Org A id and still sees nothing, under each role it
// could put in the header. Claiming a role it does not hold changes which permission set
// applies, not which rows exist for it.
await run('OrgB owner -> OrgA', ownerB, 'owner', 'empty');
await run('OrgB as editor -> OrgA', ownerB, 'editor', 'empty');
await run('OrgB as viewer -> OrgA', ownerB, 'viewer', 'empty');

// Positive: the same probes from inside Org A must return data, or the negatives prove
// nothing at all.
await run('OrgA owner -> OrgA', ownerA, 'owner', 'present');
await run('OrgA viewer -> OrgA', viewerA, 'viewer', 'present');

// An Org A member claiming a role they do not hold gets that permission set and no rows.
await run('OrgA viewer as owner', viewerA, 'owner', 'empty');

// The default `user` role exists so the app can discover its own memberships before it
// can pick a role. It must not become a way around the org scoping.
await run('OrgB as user -> OrgA', ownerB, 'user', 'empty');

report();
