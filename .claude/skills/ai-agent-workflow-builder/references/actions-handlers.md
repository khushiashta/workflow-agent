# Actions and the execution engine

## Layout

nhost routes a file at `functions/<path>.ts` to `/<path>`. Directories prefixed with `_` are not
routed, which is where shared code goes.

```
functions/
├── actions/
│   ├── trigger-workflow-run.ts        POST /actions/trigger-workflow-run
│   ├── approve-step.ts                POST /actions/approve-step
│   └── webhook-trigger.ts             POST /actions/webhook-trigger
├── events/
│   ├── deliver-notification.ts        Event Trigger: notifications insert
│   └── document-created.ts            Event Trigger: incoming_documents insert
├── cron/
│   └── scheduled-runs.ts              Cron Trigger: due schedules + stuck-run sweep
└── _lib/
    ├── admin-client.ts                GraphQL client bound to the admin secret
    ├── authorization.ts               membership resolution
    ├── quota.ts                       atomic guarded increment
    ├── retry.ts                       transient-failure classification + backoff
    ├── template.ts                    {{...}} resolution against run context
    ├── engine.ts                      run/step state machine
    ├── errors.ts                       typed errors → Hasura-visible messages
    └── steps/
        ├── index.ts                   step type → executor map
        ├── llm-call.ts
        ├── http-request.ts
        ├── db-write.ts
        ├── notify.ts
        ├── conditional-branch.ts
        └── approval-gate.ts
```

## Action definitions

```graphql
type TriggerWorkflowRunOutput {
  workflow_run_id: uuid!
  status: String!
}

type ApproveStepOutput {
  step_run_id: uuid!
  workflow_run_id: uuid!
  status: String!
}

type WebhookTriggerOutput {
  workflow_run_id: uuid!
  status: String!
}

type Mutation {
  triggerWorkflowRun(workflow_id: uuid!, payload: jsonb): TriggerWorkflowRunOutput!
  approveStep(step_run_id: uuid!, comment: String): ApproveStepOutput!
  startWorkflowRunViaWebhook(
    workflow_id: uuid!
    token: String!
    payload: jsonb
  ): WebhookTriggerOutput!
}
```

Metadata for each: `kind: synchronous`, handler `{{NHOST_FUNCTIONS_URL}}/actions/<name>`,
`forward_client_headers: false`. Session variables arrive in the request body regardless, and
forwarding client headers would let a caller smuggle values the handler might trust.

Permissions per `hasura-permissions.md`: the first two for `owner` and `editor`, the webhook one
for `public`.

## The request contract

```ts
type ActionRequest<TInput> = {
  action: { name: string };
  input: TInput;
  session_variables: Record<string, string | undefined>;
  request_query: string;
};
```

`session_variables['x-hasura-user-id']` and `['x-hasura-role']` are set by Hasura from the
verified JWT. They are the only trustworthy identity in the request. `input` is entirely
attacker-controlled — treat `workflow_id` as a pointer to look up, never as a statement about
which org the caller belongs to.

Errors: return a 400 with `{ message, extensions: { code } }`. Hasura surfaces `message` to the
client, so write it for the person reading the toast.

```ts
// _lib/errors.ts
export class HandlerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export const forbidden = (m: string) => new HandlerError(m, 'forbidden', 403);
export const notFound = (m: string) => new HandlerError(m, 'not-found', 404);
export const conflict = (m: string) => new HandlerError(m, 'conflict', 409);
export const quotaExhausted = () =>
  new HandlerError('Organization quota exhausted for this period', 'quota-exhausted', 402);

export function sendError(res: Response, error: unknown) {
  if (error instanceof HandlerError) {
    return res.status(error.status).json({
      message: error.message,
      extensions: { code: error.code },
    });
  }
  console.error(error);
  return res.status(500).json({
    message: 'Internal error while processing the workflow',
    extensions: { code: 'internal' },
  });
}
```

Generic 500 text with the detail in the log, specific text for the errors a user can act on.
Leaking internals through `message` is how schemas get enumerated.

## Authorization

```ts
// _lib/authorization.ts
import { adminClient } from './admin-client';
import { forbidden, notFound } from './errors';

export type OrgRole = 'owner' | 'editor' | 'viewer';

type WorkflowAccess = {
  workflowId: string;
  orgId: string;
  role: OrgRole;
  organization: { quota_calls_allowed: number; quota_calls_used: number };
};

export function requireUserId(sessionVariables: Record<string, string | undefined>): string {
  const userId = sessionVariables['x-hasura-user-id'];
  if (!userId) throw forbidden('Authentication required');
  return userId;
}

export async function authorizeWorkflowAccess(
  workflowId: string,
  userId: string,
  allowedRoles: readonly OrgRole[],
): Promise<WorkflowAccess> {
  const { workflows_by_pk: workflow } = await adminClient.request(WORKFLOW_WITH_MEMBERSHIP, {
    workflowId,
    userId,
  });

  if (!workflow) throw notFound('Workflow not found');

  const membership = workflow.organization.members.at(0);
  if (!membership) throw notFound('Workflow not found');

  if (!allowedRoles.includes(membership.role)) {
    throw forbidden(`Your role (${membership.role}) cannot perform this action`);
  }

  return {
    workflowId: workflow.id,
    orgId: workflow.org_id,
    role: membership.role,
    organization: workflow.organization,
  };
}
```

```graphql
query WorkflowWithMembership($workflowId: uuid!, $userId: uuid!) {
  workflows_by_pk(id: $workflowId) {
    id
    org_id
    is_active
    organization {
      id
      quota_calls_allowed
      quota_calls_used
      members(where: { user_id: { _eq: $userId } }) {
        role
      }
    }
  }
}
```

Three things this gets right and are easy to get wrong:

- The org comes from the **workflow row**, so a caller cannot name Org A's workflow and have it
  evaluated against their Org B membership.
- A non-member gets `notFound`, not `forbidden`. `forbidden` confirms the workflow exists, which
  is the same leak the Hasura filters avoid by returning `null`. Keep the two layers telling the
  same story.
- Membership is fetched in the same round trip as the resource. Two queries invite a
  time-of-check gap and cost a round trip on the hot path.

## Quota

```ts
// _lib/quota.ts
import { adminClient } from './admin-client';
import { quotaExhausted } from './errors';

export function assertQuotaAvailable(org: {
  quota_calls_used: number;
  quota_calls_allowed: number;
}) {
  if (org.quota_calls_used >= org.quota_calls_allowed) throw quotaExhausted();
}

export async function consumeQuota(orgId: string): Promise<void> {
  const { consume_org_quota: consumed } = await adminClient.request(CONSUME_QUOTA, { orgId });
  // Guarded increment rather than read-then-write: concurrent runs would both observe
  // headroom and overshoot the allowance.
  if (consumed.length === 0) throw quotaExhausted();
}
```

Hasura's `where` can't compare one column against another, so the `used < allowed` guard can't be
expressed as an `update_organizations` mutation. Push it into a Postgres function, which also
keeps the check and the increment inside a single statement:

```sql
create or replace function public.consume_org_quota(target_org_id uuid)
returns setof public.organizations as $$
  update public.organizations
     set quota_calls_used = quota_calls_used + 1,
         updated_at = now()
   where id = target_org_id
     and quota_calls_used < quota_calls_allowed
  returning *;
$$ language sql volatile;
```

Track it as a Hasura mutation with **no role permissions** — admin only. Zero rows returned
means the quota was exhausted.

The flow: check availability before creating the run (so the user gets a clear refusal instead of
a failed run), and consume on completion (so failed runs don't burn allowance). Under a
concurrent burst several runs can start against one remaining call and only one will consume it;
reserve-then-release closes that at the cost of compensation logic on every failure path. For
this scope, check-then-consume with the guarded increment is the right trade — note it in the
write-up rather than silently picking.

## Retry

```ts
// _lib/retry.ts
export const MAX_STEP_ATTEMPTS = 2;

export class TransientError extends Error {}
export class PermanentError extends Error {}

export function classifyHttpFailure(status: number): TransientError | PermanentError {
  const message = `Upstream responded ${status}`;
  // 4xx other than 408/429 mean the request itself is wrong; retrying reproduces it
  // and, for paid LLM APIs, bills for it.
  return status === 408 || status === 429 || status >= 500
    ? new TransientError(message)
    : new PermanentError(message);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  { attempts = MAX_STEP_ATTEMPTS, baseDelayMs = 500 } = {},
): Promise<{ result: T; attemptCount: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { result: await operation(attempt), attemptCount: attempt };
    } catch (error) {
      lastError = error;
      if (error instanceof PermanentError || attempt === attempts) break;
      await delay(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
    }
  }

  throw lastError;
}
```

Retrying a 400 is worse than not retrying: it doubles latency, doubles spend, and hides the
actual bug. The jitter matters once more than one run retries at the same moment against the same
upstream.

`attempt_count` on `step_runs` records what actually happened, so persist the returned
`attemptCount` even on success — a step that needed two tries is a signal worth keeping.

## Template resolution

```ts
// _lib/template.ts
export type RunContext = {
  trigger: { type: string; payload: unknown };
  steps: Record<number, { output: unknown }>;
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;

export function resolveTemplates<T>(value: T, context: RunContext): T {
  if (typeof value === 'string') return resolveString(value, context) as T;
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, context)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]),
    ) as T;
  }
  return value;
}
```

Resolve only `trigger.*` and `steps.<order>.output.*`; throw on any other root. An unresolved
placeholder should also throw rather than passing `{{steps.1.output.text}}` to an LLM as
literal text — a silent pass-through turns a wiring bug into a plausible-looking wrong answer.
Never `eval`; the moment configs become expressions, a workflow author has code execution in
your function runtime.

## The engine

```ts
// _lib/engine.ts
export type ExecuteRunResult = { status: 'succeeded' | 'failed' | 'paused' | 'deferred' };

const WALL_CLOCK_BUDGET_MS = 20_000;

export async function executeRun(runId: string): Promise<ExecuteRunResult> {
  const startedAt = Date.now();

  const claimed = await claimRun(runId);
  if (!claimed) return { status: 'deferred' };

  const { run, steps } = claimed;
  const context = buildContext(run);
  let stepOrder = run.resume_from_step_order ?? steps[0]?.step_order;

  while (stepOrder !== null && stepOrder !== undefined) {
    const step = steps.find((candidate) => candidate.step_order === stepOrder);
    if (!step) break;

    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      // Leave the run claimed with a stale heartbeat; the cron sweeper resumes it.
      await markRunDeferred(run.id, stepOrder);
      return { status: 'deferred' };
    }

    const stepRun = await claimStepRun(run.id, step, context);
    if (!stepRun) {
      stepOrder = nextStepOrder(steps, stepOrder);
      continue;
    }

    if (step.step_type === 'approval_gate') {
      await pauseForApproval(run.id, stepRun.id, stepOrder);
      return { status: 'paused' };
    }

    try {
      const executor = STEP_EXECUTORS[step.step_type];
      const { result, attemptCount } = await withRetry((attempt) =>
        executor({ step, stepRun, run, context, attempt }),
      );

      await completeStepRun(stepRun.id, result.output, attemptCount);
      context.steps[step.step_order] = { output: result.output };
      stepOrder = result.nextStepOrder ?? nextStepOrder(steps, stepOrder);
    } catch (error) {
      await failStepRun(stepRun.id, error);
      await failRun(run.id, error);
      return { status: 'failed' };
    }
  }

  await succeedRun(run.id, context);
  await consumeQuota(run.org_id);
  return { status: 'succeeded' };
}
```

### Claiming, and why it's conditional everywhere

```graphql
mutation ClaimRun($runId: uuid!, $now: timestamptz!) {
  update_workflow_runs(
    where: { id: { _eq: $runId }, status: { _in: ["queued", "paused"] } }
    _set: { status: "running", started_at: $now, heartbeat_at: $now, error: null }
  ) {
    affected_rows
    returning { id org_id workflow_id context resume_from_step_order }
  }
}
```

`affected_rows === 0` means someone else already owns this run — a duplicate webhook delivery, a
double-clicked button, the sweeper racing the Action. Returning `deferred` instead of executing
is what keeps a run from being executed twice. The same pattern claims a step:

```graphql
mutation ClaimStepRun($stepRunId: uuid!, $input: jsonb!, $now: timestamptz!) {
  update_step_runs(
    where: { id: { _eq: $stepRunId }, status: { _in: ["pending", "awaiting_approval"] } }
    _set: { status: "running", started_at: $now, input: $input, error: null }
  ) {
    affected_rows
    returning { id status attempt_count }
  }
}
```

Upsert the `step_runs` row first (`on_conflict` on `(workflow_run_id, workflow_step_id)`,
`update_columns: []` so a redelivery doesn't clobber a finished step), then claim it. Insert
every step's row as `pending` when the run is created — the subscription can then render the
full ladder immediately instead of having rows appear one at a time, which is a visibly better
demo *and* removes a class of "is it pending or does it not exist" ambiguity from the UI.

### Pausing

```graphql
mutation PauseForApproval($runId: uuid!, $stepRunId: uuid!, $stepOrder: Int!) {
  update_workflow_runs_by_pk(
    pk_columns: { id: $runId }
    _set: { status: "paused", resume_from_step_order: $stepOrder }
  ) { id status }

  update_step_runs_by_pk(
    pk_columns: { id: $stepRunId }
    _set: { status: "awaiting_approval" }
  ) { id status }
}
```

One mutation, two updates, one transaction — Hasura runs multiple root fields in a mutation
inside a single transaction, so the run and the step can't disagree about whether it's paused.
`resume_from_step_order` records where to pick up so resume doesn't re-derive it from statuses.

## Step executors

Each executor takes the step, the run context, and the attempt number, and returns
`{ output, nextStepOrder? }`. Keeping them uniform is what lets the engine stay a state machine
with no per-type branching beyond the map.

```ts
export type StepExecutor = (args: {
  step: WorkflowStepRow;
  stepRun: StepRunRow;
  run: WorkflowRunRow;
  context: RunContext;
  attempt: number;
}) => Promise<{ output: unknown; nextStepOrder?: number | null }>;
```

### `llm_call`

Validate config with Zod, resolve templates, call the API with an `AbortController` timeout,
classify failures via `classifyHttpFailure`. Groq's OpenAI-compatible endpoint works well on a
free tier:

```ts
const response = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.LLM_API_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: config.model ?? process.env.LLM_MODEL,
    temperature: config.temperature ?? 0.2,
    max_tokens: config.max_tokens ?? 512,
    messages: [{ role: 'user', content: prompt }],
  }),
  signal: AbortSignal.timeout(config.timeout_ms ?? 30_000),
});
```

Output shape `{ text, model, usage }` — `usage` is what makes per-org cost reporting possible
later without a migration.

When `LLM_API_KEY` is absent, return a stub with a disclosed artificial delay and
`output.stubbed = true`, and surface that flag in the UI. A stub that's indistinguishable from a
real call is a trap for whoever debugs this next.

### `http_request`

The one place that needs a security check beyond authorization: a workflow author supplies the
URL, so without a guard this step is a server-side request forgery primitive pointed at the
cloud metadata endpoint and your internal services.

```ts
// _lib/steps/http-request.ts
const BLOCKED_HOSTNAMES = new Set(['localhost', '169.254.169.254', 'metadata.google.internal']);

function assertUrlIsAllowed(rawUrl: string): URL {
  const url = new URL(rawUrl);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PermanentError('Only http and https URLs are allowed');
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname) || isPrivateAddress(url.hostname)) {
    throw new PermanentError('Requests to internal addresses are not allowed');
  }
  return url;
}
```

Cover `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, and `fc00::/7`.
Follow redirects manually (`redirect: 'manual'`) and re-check each hop, since a permitted host can
302 to an internal one. Cap the response body you persist — an unbounded body becomes an
unbounded JSONB column.

### `conditional_branch`

```ts
const OPERATORS = {
  equals: (l, r) => l === r,
  not_equals: (l, r) => l !== r,
  contains: (l, r) => String(l).toLowerCase().includes(String(r).toLowerCase()),
  greater_than: (l, r) => Number(l) > Number(r),
  less_than: (l, r) => Number(l) < Number(r),
  is_truthy: (l) => Boolean(l),
} as const;
```

Returns `{ output: { matched, evaluated_left }, nextStepOrder }`. Persisting the resolved left
operand alongside the verdict is what makes "why did it take the else branch?" answerable from
the run record instead of from guesswork. Mark the steps the branch bypassed as `skipped` so the
UI ladder stays honest about what ran.

### `db_write`

Insert into `step_outputs` with `org_id` taken from the **run**, never from config. A config-
supplied `org_id` would let an Org A workflow write rows into Org B.

### `notify`

The step inserts a `notifications` row and returns immediately; a Hasura Event Trigger on that
insert delivers it. Two reasons this is better than calling Slack inline: run latency stops
depending on a third party's availability, and Hasura's event `retry_conf` gives at-least-once
delivery with backoff for free instead of you writing a delivery queue. The step's success means
"queued", and the notification row carries the delivery status — see `triggers.md`.

### `approval_gate`

Has no executor. The engine handles it directly, because the semantics are "stop", and an
executor that returns is the wrong shape for that.

## `triggerWorkflowRun`

```ts
export default async function handler(req: Request, res: Response) {
  try {
    const { input, session_variables } = req.body as ActionRequest<{
      workflow_id: string;
      payload?: unknown;
    }>;

    const userId = requireUserId(session_variables);
    const access = await authorizeWorkflowAccess(input.workflow_id, userId, ['owner', 'editor']);

    assertQuotaAvailable(access.organization);

    const run = await createRun({
      workflowId: access.workflowId,
      orgId: access.orgId,
      triggerType: 'manual',
      triggeredBy: userId,
      payload: input.payload ?? {},
    });

    const { status } = await executeRun(run.id);

    return res.status(200).json({ workflow_run_id: run.id, status });
  } catch (error) {
    return sendError(res, error);
  }
}
```

`createRun` inserts the run **and** all its `step_runs` as `pending` in one mutation, so the
subscription has the full ladder from the first frame.

Returning after the run reaches a terminal or paused state keeps the Action synchronous and the
client simple. If the wall-clock budget trips first, the response is `deferred` and the cron
sweeper finishes it — the UI is subscription-driven, so it keeps updating either way. The upgrade
path when steps get slow is a durable queue plus a worker; nothing above needs to change except
who calls `executeRun`.

## `approveStep`

```ts
export default async function handler(req: Request, res: Response) {
  try {
    const { input, session_variables } = req.body as ActionRequest<{
      step_run_id: string;
      comment?: string;
    }>;

    const userId = requireUserId(session_variables);

    const stepRun = await fetchStepRunForApproval(input.step_run_id, userId);
    if (!stepRun) throw notFound('Step run not found');

    const membership = stepRun.workflow_run.workflow.organization.members.at(0);
    if (!membership) throw notFound('Step run not found');

    const allowedRoles = parseAllowedRoles(stepRun.step.config) ?? ['owner', 'editor'];
    if (!allowedRoles.includes(membership.role)) {
      throw forbidden(`Your role (${membership.role}) cannot approve this step`);
    }

    const claimed = await claimApproval(stepRun.id, userId);
    if (!claimed) throw conflict('This step is no longer awaiting approval');

    const { status } = await executeRun(stepRun.workflow_run_id);

    return res.status(200).json({
      step_run_id: stepRun.id,
      workflow_run_id: stepRun.workflow_run_id,
      status,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
```

```graphql
mutation ClaimApproval($stepRunId: uuid!, $userId: uuid!, $now: timestamptz!) {
  update_step_runs(
    where: { id: { _eq: $stepRunId }, status: { _eq: "awaiting_approval" } }
    _set: { status: "succeeded", approved_by: $userId, approved_at: $now, finished_at: $now }
  ) {
    affected_rows
  }
}
```

This handler is where layer 2 is genuinely enforced, so it's worth naming what each line buys:

- The step run is fetched **with** the caller's membership through
  `step_run → workflow_run → workflow → organization → members(where user_id)`. An Org B user
  passing a valid Org A `step_run_id` gets an empty `members` array and therefore `notFound` —
  the ID being real doesn't help them.
- The role check happens against the membership row, not against `x-hasura-role`. Hasura already
  proved the caller *has* the role somewhere; only the database proves they have it *here*.
- `config.allowed_roles` can narrow further, which is why this can't be a static permission.
- `claimApproval` is conditional on `awaiting_approval`, so two approvers clicking at once
  produce one approval and one clean `409` — not two resumes of the same run.
- Resume goes through the same `executeRun`, starting from `resume_from_step_order`. There is no
  second execution path to keep in sync.

## `startWorkflowRunViaWebhook`

Open to `public`, so authorization is the token:

```ts
const trigger = await fetchWebhookTrigger(input.workflow_id);
if (!trigger?.is_enabled) throw notFound('No enabled webhook trigger for this workflow');

const provided = createHash('sha256').update(input.token).digest();
const expected = Buffer.from(trigger.webhook_secret_hash, 'hex');
if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
  throw forbidden('Invalid webhook token');
}
```

`timingSafeEqual` over `===` because token comparison is the one string comparison where timing
is observable. Compare hashes, not plaintext, so the stored value isn't a usable credential.

The run is created with `trigger_type: 'webhook'` and `triggered_by: null`, and quota applies
exactly as it does for manual runs — an unauthenticated entry point that skipped quota would be a
free amplifier.

## Admin client

```ts
// _lib/admin-client.ts
export const adminClient = new GraphQLClient(process.env.NHOST_GRAPHQL_URL!, {
  headers: { 'x-hasura-admin-secret': process.env.NHOST_ADMIN_SECRET! },
});
```

The admin secret bypasses every permission, which is exactly why authorization lives explicitly
at the top of each handler. If a handler queries with the admin secret before checking
membership, that query is the vulnerability regardless of what the code does afterwards. Read
each handler top to bottom and confirm the check comes first.
