# Frontend — Next.js + TypeScript + Tailwind + shadcn/ui

## Setup

```bash
npx create-next-app@latest web --typescript --tailwind --eslint --app --no-src-dir \
  --import-alias "@/*" --use-npm --turbopack
cd web
npx shadcn@latest init -d --yes -b radix
npx shadcn@latest add card badge input textarea select dialog dropdown-menu \
  form label separator skeleton sonner table tabs tooltip alert progress --yes
npm i @nhost/nhost-js graphql-ws graphql zod react-hook-form @hookform/resolvers
```

`create-next-app` nests its own `.git` in `web/` — delete it, or the outer repo isn't the one
Turbopack resolves against and `package-lock.json` gets ignored with a warning.

**Deliberately no Apollo Client and no `@nhost/react`.** Check this yourself before reaching for
them (`npm view @nhost/react-apollo peerDependencies`) — as of `@nhost/react@3.11.2` /
`@nhost/react-apollo@18.0.2`, the Apollo bridge declares peer support for React 17/18 only and
`@nhost/react` pins `@nhost/nhost-js@3.3.1`, so neither composes with Next 16 / React 19. Pinning
the whole app to React 18 to keep a cache the app barely uses is the wrong trade: this app needs
two queries, three mutations, and two subscriptions, and subscriptions already drive every live
surface. Use `@nhost/nhost-js@4` for auth and one-shot operations, `graphql-ws` for subscriptions.

This is why the skill says to check versions rather than trust a remembered dependency set — the
failure mode is not a clean error but a peer-dep override that installs and then misbehaves.

## Structure

```
web/
├── app/
│   ├── layout.tsx                        html shell, fonts, <Toaster />
│   ├── providers.tsx                     session + active-org + ws client ('use client')
│   ├── (auth)/sign-in/page.tsx
│   ├── (auth)/sign-up/page.tsx
│   └── (app)/
│       ├── layout.tsx                    auth guard, org switcher, quota indicator
│       ├── workflows/page.tsx            list with latest run status
│       ├── workflows/new/page.tsx
│       ├── workflows/[workflowId]/page.tsx        builder
│       └── runs/[runId]/page.tsx                  live run view
├── components/
│   ├── ui/                               shadcn primitives, unedited
│   ├── org/{org-switcher,quota-indicator}.tsx
│   ├── workflows/{workflow-list,workflow-builder,step-list,step-editor,step-type-picker,trigger-editor,run-button}.tsx
│   └── runs/{run-timeline,step-run-card,approval-panel,run-status-badge}.tsx
├── lib/
│   ├── nhost/client.ts
│   ├── graphql/{client,subscribe,queries,mutations,subscriptions}.ts
│   ├── workflow/{step-types,step-config-schemas,permissions}.ts
│   └── utils.ts
├── hooks/{use-active-org,use-current-role,use-step-runs}.ts
└── types/{database,workflow}.ts
```

Everything that reads auth state is a client component. The pragmatic reason: nhost's session
lives in browser storage and refreshes there, so server components can't see it without wiring
token forwarding, and the payoff for SSR on an authenticated dashboard is small. Say this in the
README rather than leaving a reviewer to wonder whether it was a choice or an oversight.

## The GraphQL layer, with the role header

```ts
// lib/nhost/client.ts
import { createClient } from '@nhost/nhost-js';

export const nhost = createClient({
  subdomain: process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN!,
  region: process.env.NEXT_PUBLIC_NHOST_REGION,
});
```

`@nhost/nhost-js@4` exposes `createClient` / `createServerClient` plus `withAdminSession` for the
handler side, and namespaced surfaces at `@nhost/nhost-js/{auth,graphql,session}`. It manages the
session and refresh; queries and mutations go through `nhost.graphql.request`, subscriptions
through a `graphql-ws` client you own.

The one non-default thing to configure: `x-hasura-role` must carry the caller's role **in the
active org**, because Hasura resolves one role per request while a user's role is per
organization. Read it from the active membership and set it on every operation, HTTP and
WebSocket alike — a subscription that omits the header falls back to the default role and quietly
returns nothing, which reads as "subscriptions are broken" rather than as a header problem.

For the WebSocket client, put the role in `connectionParams` alongside the bearer token, and
recreate the client when the active org changes — connection params are fixed at connect time, so
switching orgs without reconnecting leaves the socket authenticated as the previous role. Keying
the provider that owns the ws client on the active org id makes React tear it down for you.
`connectionParams` as a function is what lets a reconnect pick up a refreshed token.

This is the frontend's whole contribution to layer 1, and it is a convenience, not a control: the
row filters require a matching `org_members` row, so a tampered header changes which permission
set applies and matches zero rows.

## Operations

### Org workflows with steps, triggers, and latest run status

```graphql
query OrgWorkflowsWithLatestRun($orgId: uuid!) {
  workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
    id
    name
    description
    is_active
    steps(order_by: { step_order: asc }) {
      id
      step_order
      step_type
      name
      config
    }
    triggers {
      id
      trigger_type
      is_enabled
      config
    }
    runs(order_by: { created_at: desc }, limit: 1) {
      id
      status
      trigger_type
      started_at
      finished_at
    }
  }
}
```

`runs(limit: 1)` inside the workflows query is a per-parent limit in Hasura — it becomes a lateral
join, not one query per workflow, so the list stays a single round trip. The `where` on `org_id`
is for correctness of *display* only; the permission filter is what makes it safe.

### Create or edit a workflow with steps and triggers

```graphql
mutation SaveWorkflow(
  $workflow: workflows_insert_input!
  $steps: [workflow_steps_insert_input!]!
  $triggers: [workflow_triggers_insert_input!]!
) {
  insert_workflows_one(
    object: $workflow
    on_conflict: { constraint: workflows_pkey, update_columns: [name, description, is_active] }
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
  insert_workflow_triggers(
    objects: $triggers
    on_conflict: {
      constraint: workflow_triggers_pkey
      update_columns: [trigger_type, is_enabled, config]
    }
  ) {
    affected_rows
  }
}
```

Hasura runs a mutation's root fields in one transaction, so a workflow never half-saves — and the
deferred unique constraint on `(workflow_id, step_order)` is what lets a reorder submit all the
new positions at once without a transient collision. Delete removed steps in the same mutation
with a `delete_workflow_steps(where: {id: {_nin: $keptIds}, workflow_id: {_eq: $workflowId}})`
root field, ordered before the inserts.

### Live step progress

```graphql
subscription StepRunsForWorkflowRun($workflowRunId: uuid!) {
  step_runs(
    where: { workflow_run_id: { _eq: $workflowRunId } }
    order_by: { step_order: asc }
  ) {
    id
    step_order
    status
    attempt_count
    error
    output
    approved_at
    started_at
    finished_at
    approver {
      id
      displayName
    }
    step {
      id
      name
      step_type
      config
    }
  }
}
```

Pair it with a subscription on the run itself for `status` (including `paused`) and `error`. Two
narrow subscriptions beat one nested one: Hasura re-evaluates and re-pushes the whole result set
on any change, so nesting steps under the run means every step transition re-sends the run too.

Because the engine inserts all `step_runs` as `pending` when the run is created, the ladder
renders complete from the first frame and each row transitions in place. That's both a better
demo and one less empty state to design.

## The run view

Render each step as a card keyed by `step_order` with a status treatment:

| Status | Treatment |
|---|---|
| `pending` | muted, outline badge |
| `running` | spinner, `attempt_count > 1` shown as "retry 2 of 2" |
| `awaiting_approval` | amber, approval panel expanded |
| `succeeded` | green check, output in a collapsible |
| `failed` | destructive, `error` visible without a click |
| `skipped` | dimmed, "not taken" on the branch that wasn't chosen |

Surface `attempt_count` and, for `conditional_branch`, the persisted `evaluated_left` and
`matched`. The run record already holds both; showing them is what turns the timeline from a
progress bar into something you can debug from.

## Approval panel

Renders when a step run is `awaiting_approval` and the current membership role is in the step's
`config.allowed_roles` (defaulting to owner and editor). Calls `approveStep` and does nothing
optimistic — the subscription delivers the state change, and a run whose UI says approved while
the engine disagrees is worse than a half-second of latency.

Handle the `conflict` error explicitly: two people watching the same paused run will both click,
and one gets "this step is no longer awaiting approval". That's a normal outcome, so show it as
information rather than as a failure.

## Role-driven UI

```ts
// lib/workflow/permissions.ts
export const canTriggerRun = (role: OrgRole) => role === 'owner' || role === 'editor';
export const canApproveStep = canTriggerRun;
export const canEditWorkflow = canTriggerRun;
export const canManageMembers = (role: OrgRole) => role === 'owner';
export const canAddStepType = (role: OrgRole, stepType: StepType) =>
  role === 'owner' || !PRIVILEGED_STEP_TYPES.includes(stepType);
```

One module, derived from the same role vocabulary as the database — not `role !== 'viewer'`
scattered across components. When the rules change, they change here.

Viewers get no Run button and no approve control, and privileged step types are disabled with a
tooltip ("only an owner can add a database write") rather than hidden — a disabled control with a
reason teaches the model; a missing one reads as a bug.

Keep in mind what this is: presentation. Every one of these predicates is enforced again in
Hasura or in the Action handler, and the demo's Org B check passes because of those, not because
of this file.

## Quota indicator

Subscribe to `org_usage_summary` for the active org and render
`quota_calls_used / quota_calls_allowed` as a `Progress` with the remaining count, plus
`runs_this_period` and `avg_run_seconds_this_period` in a tooltip. Amber past 80%, destructive at
zero remaining, and when it's exhausted disable the Run button with the reason — the Action
returns `quota-exhausted` either way, but finding out before you compose a run is better than
after.

Because the engine consumes quota on completion, this counter visibly ticks during the demo,
which is the cheapest possible proof that quota enforcement is live rather than decorative.

## Error surfacing

Action errors arrive as GraphQL errors with `extensions.code`. Map them to specific toasts —
`quota-exhausted`, `forbidden`, `conflict`, `not-found` — and fall back to a generic message for
anything else. The handler wrote those messages for a human to read; passing through
`"Unexpected error"` throws that away.
