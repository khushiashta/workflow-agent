# Hasura permissions — the two layers

## Layer 1 vs Layer 2, stated precisely

They are not two strengths of the same check; they answer different questions and are enforced
by different mechanisms.

**Layer 1 — org + role row scoping.** *May this caller touch this row at all?* Enforced by
Hasura row permissions. Every filter traverses `org_members` matched on `X-Hasura-User-Id`, so
the answer depends on data, not on a claim in the token. This is what makes cross-org isolation
survive ID guessing.

**Layer 2 — step-level gating.** *May this caller create, or act on, this specific kind of
step?* Two sub-cases with two mechanisms, because they are structurally different:

- *Authoring* a privileged step (`db_write`, `notify`) or a `webhook` trigger is a row write, so
  it's enforced by an insert/update **`check`** that inspects the row's own `step_type`.
- *Clearing* an `approval_gate` is not a row write anyone performs — it's a mid-execution
  decision about whether to resume a paused run. No row permission can express it, so the
  `approveStep` Action handler checks the approver's membership role itself. Users have no
  insert/update permission on `step_runs` at all, which is what makes the handler the only door.

Say this distinction out loud in the write-up; it's the conceptual centre of the assignment.

## The role model

Hasura resolves one role per request, from `x-hasura-role`. But a user's role is per
organization — owner in Org A, viewer in Org B. Reconcile it like this:

- nhost issues a JWT with `x-hasura-default-role: user` and
  `x-hasura-allowed-roles: [user, owner, editor, viewer]`.
- The frontend sends `x-hasura-role` matching the caller's membership role **in the active
  org**.
- Every permission for role `owner` additionally requires a membership row with
  `role = 'owner'`. Same for `editor` and `viewer`.

That last point is what makes it safe to grant all three roles to every authenticated user: the
role in the header selects *which permission set* applies, and the row filter proves the caller
actually holds it. A viewer who sets `x-hasura-role: owner` gets the owner permission set and
matches zero rows, because they have no owner membership anywhere. Nothing to sync, nothing to
go stale on a membership change, no trust placed in a client-supplied header.

Grant the roles in nhost by seeding `auth.roles` and `auth.user_roles` (or by configuring
default allowed roles in `nhost.toml`). Keep `HASURA_GRAPHQL_UNAUTHORIZED_ROLE` unset or bound
to a `public` role that has no table permissions at all — only the inbound webhook Action.

```jsonc
// The membership predicate, reused in nearly every filter below.
// Substitute the role being defined.
{ "organization": { "members": { "_and": [
  { "user_id": { "_eq": "X-Hasura-User-Id" } },
  { "role":    { "_eq": "owner" } }
] } } }
```

For tables one hop further out, extend the path (`workflow.organization.members`,
`workflow_run.workflow.organization.members`). Hasura compiles these into a single SQL query
with `exists` subqueries — they're join-order friendly and the `org_members (user_id)` index
covers them.

## Permission matrix

`—` means no permission for that role, which for `workflow_runs` and `step_runs` is the point:
those rows are written only by handlers using the admin secret.

| Table | owner | editor | viewer |
|---|---|---|---|
| `organizations` | select, update (own org) | select | select |
| `org_members` | select, insert, update, delete | select | select |
| `workflows` | select, insert, update, delete | select, insert, update | select |
| `workflow_steps` | select, insert, update, delete | select, insert*, update* | select |
| `workflow_triggers` | select, insert, update, delete | select, insert*, update* | select |
| `workflow_runs` | select | select | select |
| `step_runs` | select | select | select |
| `step_outputs` | select | select | select |
| `notifications` | select | select | — |
| `incoming_documents` | select, insert | select, insert | select |
| `org_usage_summary` | select | select | select |
| reference tables | select | select | select |

`*` = constrained by a layer-2 `check` on the row's type.

Notice viewers get select on `workflow_runs` — they may watch a run, they simply cannot start
one. "Cannot trigger" is enforced by the Action, not by hiding the run history.

## Layer 1 — the filters

### `organizations`

```jsonc
// select — owner (repeat with role editor / viewer)
{ "filter": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "owner" } } ] } },
  "columns": ["id", "name", "slug", "quota_calls_allowed", "quota_calls_used",
              "quota_period_started_at", "created_at", "updated_at"] }

// update — owner only, and only presentational fields.
// quota_calls_used is absent from `columns` so no client can grant itself headroom.
{ "filter": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "owner" } } ] } },
  "columns": ["name"],
  "check": {} }
```

Leaving `quota_calls_used` and `quota_calls_allowed` out of the update column list is the whole
of quota integrity on the client side. A quota you can `update` is not a quota.

### `org_members`

```jsonc
// select — all three roles see their org's roster.
{ "filter": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "<role>" } } ] } } },
  "columns": ["id", "org_id", "user_id", "role", "created_at"] }

// insert — owner only. `check` runs against the row being written, so it must
// re-prove ownership of the target org; the `filter` above governs reads, not writes.
{ "check": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "owner" } } ] } } },
  "columns": ["org_id", "user_id", "role"] }
```

The insert `check` is easy to get wrong: without it, an owner of Org A could insert a membership
row for Org B and escalate into another tenant. `filter` guards reading; `check` guards writing.
Both need the membership predicate.

Editors get no insert/update/delete here — that's the "can't manage members" line.

### `workflows`

```jsonc
// select — <role> in {owner, editor, viewer}
{ "filter": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "<role>" } } ] } } },
  "allow_aggregations": true,
  "limit": 100 }

// insert — owner and editor
{ "check": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_in": ["owner", "editor"] } } ] } } },
  "columns": ["org_id", "name", "description", "is_active"],
  "set": { "created_by": "x-hasura-User-Id" } }

// update — owner and editor; `check` mirrors `filter` so a row can't be
// moved into another org by updating org_id (org_id is also absent from columns).
{ "filter": "<same as insert check>",
  "check":  "<same as insert check>",
  "columns": ["name", "description", "is_active"] }

// delete — owner only
{ "filter": "<owner membership predicate>" }
```

Two habits worth keeping everywhere: `set` the `created_by` from the session variable rather
than accepting it from the client, and set a `limit` on select so a single query can't ask for
the whole table. Neither is required for the demo; both are what "scalable, not a demo shortcut"
looks like in review.

### `workflow_runs` and `step_runs`

```jsonc
// workflow_runs select — <role>
{ "filter": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "<role>" } } ] } } },
  "allow_aggregations": true,
  "limit": 100 }

// step_runs select — <role>. Traverses the denormalized org_id on the run.
{ "filter": { "workflow_run": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "<role>" } } ] } } } },
  "limit": 500 }
```

No insert, update, or delete for any role on either table. This is deliberate and is the
mechanism behind invariant 3: without an update permission on `step_runs`, a user cannot set
`approved_by = self` and cannot flip a status. The only path to approval is the Action, and the
Action checks the role.

This same filter is what the live subscription runs under, so isolation and liveness are the
same rule — there is no second code path to get wrong.

### `org_usage_summary`

```jsonc
{ "filter": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "<role>" } } ] } } },
  "columns": ["org_id", "quota_calls_allowed", "quota_calls_used", "quota_calls_remaining",
              "quota_period_started_at", "runs_this_period", "failed_runs_this_period",
              "avg_run_seconds_this_period"] }
```

Requires the manual object relationship from the view to `organizations`. Views inherit nothing
— an untracked view is invisible, a tracked view with no permission is invisible to non-admins,
and a tracked view with a careless permission is a leak. Test this one as an Org B user
explicitly.

### Reference tables

`select` for all three roles with `filter: {}` and no columns withheld. These are static
vocabularies; scoping them would only break the builder's dropdowns.

## Layer 2 — step-level gating

### `workflow_steps` insert

```jsonc
// owner — no type restriction
{ "check": { "workflow": { "organization": { "members": { "_and": [
      { "user_id": { "_eq": "X-Hasura-User-Id" } },
      { "role": { "_eq": "owner" } } ] } } } },
  "columns": ["workflow_id", "step_order", "step_type", "name", "config"],
  "set": { "created_by": "x-hasura-User-Id" } }

// editor — same org scoping, plus the privileged types excluded
{ "check": { "_and": [
    { "workflow": { "organization": { "members": { "_and": [
        { "user_id": { "_eq": "X-Hasura-User-Id" } },
        { "role": { "_eq": "editor" } } ] } } } },
    { "step_type": { "_nin": ["db_write", "notify"] } } ] },
  "columns": ["workflow_id", "step_order", "step_type", "name", "config"],
  "set": { "created_by": "x-hasura-User-Id" } }
```

### `workflow_steps` update

```jsonc
// editor — the type predicate belongs in BOTH filter and check.
// filter: you may not edit a privileged step that already exists.
// check:  you may not turn a permitted step into a privileged one.
{ "filter": { "_and": [
    { "workflow": { "organization": { "members": { "_and": [
        { "user_id": { "_eq": "X-Hasura-User-Id" } },
        { "role": { "_eq": "editor" } } ] } } } },
    { "step_type": { "_nin": ["db_write", "notify"] } } ] },
  "check": { "step_type": { "_nin": ["db_write", "notify"] } },
  "columns": ["step_order", "step_type", "name", "config"] }
```

Omitting the `check` here is the classic hole: the `filter` alone lets an editor select a
harmless `http_request` step and update its `step_type` to `db_write`. `filter` is the
pre-image, `check` is the post-image, and a type restriction needs both.

### `workflow_triggers`

Identical shape, restricting `trigger_type`:

```jsonc
// editor insert/update — webhook triggers are owner-only
{ "check": { "_and": [
    { "workflow": { "organization": { "members": { "_and": [
        { "user_id": { "_eq": "X-Hasura-User-Id" } },
        { "role": { "_eq": "editor" } } ] } } } },
    { "trigger_type": { "_nin": ["webhook"] } } ] },
  "columns": ["workflow_id", "trigger_type", "is_enabled", "config"] }
```

`webhook_secret_hash` appears in **no** role's select or insert columns. It's written by the
handler that mints the token and read by the handler that verifies it, both with the admin
secret.

### The approval gate — why the handler must do it

An `approval_gate` is cleared by moving a `step_run` from `awaiting_approval` to `succeeded` and
stamping `approved_by`/`approved_at`. Expressing that as a row permission fails on three counts:

- The decision depends on **run state** (`status = 'awaiting_approval'`), and a permission that
  reads state can't also guarantee it hasn't changed between check and write. The handler does a
  guarded update and branches on `affected_rows`, which is race-free.
- Approving must **resume execution**. A row update can't continue the run; a handler can.
- The gate may narrow its own approvers via `config.allowed_roles`, which is per-step data. A
  static permission rule can't consult it.

So: no write permission on `step_runs`, and `approveStep` verifies membership, verifies the
step's `allowed_roles`, claims the transition atomically, then resumes. See
`actions-handlers.md`.

## Action permissions

| Action | Roles |
|---|---|
| `triggerWorkflowRun` | `owner`, `editor` |
| `approveStep` | `owner`, `editor` |
| `startWorkflowRunViaWebhook` | `public` |

Action permissions only control *who may call*; every handler re-derives authorization from the
database because an Action reachable by role `editor` says nothing about *which org's* workflow
the caller named. The webhook Action is deliberately open to `public` and is authorized entirely
by its per-trigger token.

## Verifying, not assuming

Admin-secret queries bypass every rule above, so a test run as admin proves nothing. Test with a
real token:

```bash
curl -s "$HASURA_GRAPHQL_URL" \
  -H "Authorization: Bearer $ORG_B_USER_JWT" \
  -H "x-hasura-role: owner" \
  -H 'content-type: application/json' \
  -d '{"query":"query { workflows_by_pk(id: \"'"$ORG_A_WORKFLOW_ID"'\") { id name } }"}'
```

Expect `{"data":{"workflows_by_pk":null}}`. A permission *error* would still be a leak — it
confirms the row exists. `null` is the correct answer to "does Org A's workflow exist?" when
asked by Org B.

Run the same probe against `workflow_runs_by_pk`, `step_runs_by_pk`, `org_usage_summary`, and
the `approveStep` mutation before declaring isolation airtight. `verification.md` has the full
set.
