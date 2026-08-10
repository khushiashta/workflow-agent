/**
 * Seeds two organizations with their own users and roles.
 *
 * Cross-org isolation is unprovable with a single tenant, so this is a prerequisite for
 * the acceptance test rather than a convenience. Re-running is safe: users fall back to
 * sign-in, and every row is upserted on a stable id.
 */

const authUrl = requireEnv('NHOST_AUTH_URL');
const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');
const adminSecret = requireEnv('NHOST_ADMIN_SECRET');
const password = requireEnv('SEED_USER_PASSWORD');

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';
const ORG_B_ID = '22222222-2222-2222-2222-222222222222';
const WORKFLOW_ID = '33333333-3333-3333-3333-333333333333';

type OrgRole = 'owner' | 'editor' | 'viewer';

type SeedMember = {
  email: string;
  displayName: string;
  orgId: string;
  role: OrgRole;
};

// nhost's displayName validator rejects punctuation beyond spaces, hyphens, periods and
// apostrophes, so the org lives in the email rather than the name.
const MEMBERS: SeedMember[] = [
  { email: 'owner-a@example.com', displayName: 'Ava Owner', orgId: ORG_A_ID, role: 'owner' },
  { email: 'editor-a@example.com', displayName: 'Eli Editor', orgId: ORG_A_ID, role: 'editor' },
  { email: 'viewer-a@example.com', displayName: 'Vic Viewer', orgId: ORG_A_ID, role: 'viewer' },
  { email: 'owner-b@example.com', displayName: 'Bo Owner', orgId: ORG_B_ID, role: 'owner' },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': adminSecret },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join('; '));
  }
  if (!body.data) throw new Error(`No data returned (HTTP ${response.status})`);
  return body.data;
}

async function ensureUser(member: SeedMember): Promise<string> {
  const signUp = await fetch(`${authUrl}/signup/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: member.email,
      password,
      options: { displayName: member.displayName, allowedRoles: ['user', 'me', 'owner', 'editor', 'viewer'] },
    }),
  });

  let signUpDetail = '';
  if (signUp.ok) {
    const created = (await signUp.json()) as { session?: { user?: { id: string } } };
    const id = created.session?.user?.id;
    if (id) return id;
    signUpDetail = 'sign-up returned no session';
  } else {
    signUpDetail = await signUp.text();
  }

  const signIn = await fetch(`${authUrl}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: member.email, password }),
  });

  if (!signIn.ok) {
    // Report both legs. Sign-in failing second is usually a symptom of sign-up failing
    // first, and surfacing only the 401 sends you looking at passwords instead.
    throw new Error(
      `Could not create or sign in ${member.email}.\n` +
        `  sign-up (HTTP ${signUp.status}): ${signUpDetail}\n` +
        `  sign-in (HTTP ${signIn.status}): ${await signIn.text()}\n` +
        `  If the account predates the current SEED_USER_PASSWORD, delete it from auth.users.`,
    );
  }

  const session = (await signIn.json()) as { session?: { user?: { id: string } } };
  const id = session.session?.user?.id;
  if (!id) throw new Error(`Sign-in for ${member.email} returned no user id`);
  return id;
}

async function upsertOrganizations(): Promise<void> {
  await graphql(
    `
      mutation SeedOrganizations($objects: [organizations_insert_input!]!) {
        insert_organizations(
          objects: $objects
          on_conflict: {
            constraint: organizations_pkey
            update_columns: [name, slug, quota_calls_allowed]
          }
        ) {
          affected_rows
        }
      }
    `,
    {
      objects: [
        { id: ORG_A_ID, name: 'Org A', slug: 'org-a', quota_calls_allowed: 50 },
        { id: ORG_B_ID, name: 'Org B', slug: 'org-b', quota_calls_allowed: 50 },
      ],
    },
  );
}

async function upsertMemberships(userIds: Map<string, string>): Promise<void> {
  await graphql(
    `
      mutation SeedMemberships($objects: [org_members_insert_input!]!) {
        insert_org_members(
          objects: $objects
          on_conflict: { constraint: org_member_unique_per_org, update_columns: [role] }
        ) {
          affected_rows
        }
      }
    `,
    {
      objects: MEMBERS.map((member) => ({
        org_id: member.orgId,
        user_id: userIds.get(member.email),
        role: member.role,
      })),
    },
  );
}

/**
 * A fixture workflow in Org A so the isolation probes and the engine have a real target
 * before the builder UI exists. The recorded demo builds its own through the UI.
 */
async function upsertFixtureWorkflow(ownerId: string): Promise<void> {
  await graphql(
    `
      mutation SeedWorkflow(
        $workflow: workflows_insert_input!
        $steps: [workflow_steps_insert_input!]!
        $trigger: workflow_triggers_insert_input!
      ) {
        insert_workflows_one(
          object: $workflow
          on_conflict: { constraint: workflows_pkey, update_columns: [name, description] }
        ) {
          id
        }
        insert_workflow_steps(
          objects: $steps
          on_conflict: {
            constraint: workflow_steps_pkey
            update_columns: [step_order, step_type, name, config]
          }
        ) {
          affected_rows
        }
        insert_workflow_triggers_one(
          object: $trigger
          on_conflict: { constraint: workflow_triggers_pkey, update_columns: [is_enabled] }
        ) {
          id
        }
      }
    `,
    {
      workflow: {
        id: WORKFLOW_ID,
        org_id: ORG_A_ID,
        name: 'Support triage',
        description: 'Classifies an inbound message, escalates urgent ones through an approval gate',
        created_by: ownerId,
      },
      steps: [
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000001',
          workflow_id: WORKFLOW_ID,
          step_order: 1,
          step_type: 'llm_call',
          name: 'Classify urgency',
          created_by: ownerId,
          config: {
            prompt:
              'Reply with exactly one word, URGENT or NORMAL. Message: {{trigger.payload.text}}',
            temperature: 0,
            max_tokens: 8,
          },
        },
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000002',
          workflow_id: WORKFLOW_ID,
          step_order: 2,
          step_type: 'conditional_branch',
          name: 'Urgent?',
          created_by: ownerId,
          config: {
            left: '{{steps.1.output.text}}',
            operator: 'contains',
            right: 'URGENT',
            then_step_order: 3,
            else_step_order: 5,
          },
        },
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000003',
          workflow_id: WORKFLOW_ID,
          step_order: 3,
          step_type: 'approval_gate',
          name: 'Approve escalation',
          created_by: ownerId,
          config: {
            instructions: 'Confirm this should be escalated before notifying the customer',
            allowed_roles: ['owner', 'editor'],
          },
        },
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000004',
          workflow_id: WORKFLOW_ID,
          step_order: 4,
          step_type: 'http_request',
          name: 'Notify escalation endpoint',
          created_by: ownerId,
          config: { method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 },
        },
        {
          id: 'aaaaaaaa-0000-0000-0000-000000000005',
          workflow_id: WORKFLOW_ID,
          step_order: 5,
          step_type: 'db_write',
          name: 'Record verdict',
          created_by: ownerId,
          config: { label: 'triage_verdict', payload: { verdict: '{{steps.1.output.text}}' } },
        },
      ],
      trigger: {
        id: 'bbbbbbbb-0000-0000-0000-000000000001',
        workflow_id: WORKFLOW_ID,
        trigger_type: 'manual',
        is_enabled: true,
        created_by: ownerId,
      },
    },
  );
}

async function main(): Promise<void> {
  const userIds = new Map<string, string>();
  for (const member of MEMBERS) {
    userIds.set(member.email, await ensureUser(member));
  }

  await upsertOrganizations();
  await upsertMemberships(userIds);

  const ownerId = userIds.get('owner-a@example.com');
  if (!ownerId) throw new Error('Org A owner was not created');
  await upsertFixtureWorkflow(ownerId);

  console.log('\nSeeded two organizations.\n');
  console.log(`  Org A            ${ORG_A_ID}`);
  console.log(`  Org B            ${ORG_B_ID}`);
  console.log(`  Fixture workflow ${WORKFLOW_ID} (Org A)\n`);
  for (const member of MEMBERS) {
    const org = member.orgId === ORG_A_ID ? 'Org A' : 'Org B';
    console.log(`  ${member.email.padEnd(22)} ${org} ${member.role.padEnd(7)} ${userIds.get(member.email)}`);
  }
  console.log(`\n  Password for all four: ${password}\n`);
}

await main();
