# Design write-up

## Schema reasoning

The relationship spine is `organizations → org_members → workflows → steps/triggers` and
`workflow → runs → step_runs`. Three decisions in it are load-bearing.

**`org_id` is denormalized onto `workflow_runs`, and pinned by a composite foreign key.**
Without it, the permission filter on `step_runs` traverses `run → workflow → organization →
members`, and that filter runs on the hottest path in the app — the live run subscription. The
usual objection to denormalizing is drift, so it is made impossible rather than unlikely:
`workflows` carries `unique (id, org_id)` and `workflow_runs` declares
`foreign key (workflow_id, org_id) references workflows (id, org_id)`. A run whose `org_id`
disagrees with its workflow's cannot be inserted — not by a handler, not by a migration, not by
psql. The cost is that Hasura can no longer infer the `workflow` relationship from a column
(two foreign keys overlap on `workflow_id`), so that one is configured manually.

**Step ordering uses a `deferrable initially deferred` unique constraint on
`(workflow_id, step_order)`.** Reordering means swapping positions, which transiently
collides; deferring the check to commit lets the builder submit every new position in one
transaction. The alternative — sparse float ordering — trades a clean invariant for
rebalancing logic.

**`step_runs` is unique on `(workflow_run_id, workflow_step_id)`.** This is what makes step
claiming idempotent: a redelivered webhook upserts onto that key instead of producing a second
step run for the same step.

Status and type columns are `text` with `CHECK` constraints rather than enum reference tables.
Reference tables would give Hasura-level GraphQL enums, but at the cost of six more tracked
tables and eighteen more permission entries for no gain the demo can see. `run_statuses`
includes `paused`, and `step_statuses` includes `awaiting_approval` — a distinct step status
matters because the subscription is on `step_runs`, so the UI needs to know *which* step is
blocking, not merely that something is.

## The two permission layers are enforced by different mechanisms

They are not two strengths of one check. They answer different questions and live in different
places.

**Layer 1 — org and role scoping — is Hasura row permissions.** Every rule traverses
`org_members` matched on `X-Hasura-User-Id` and requires the exact role being defined:

```yaml
filter:
  organization:
    members:
      _and:
        - user_id: { _eq: X-Hasura-User-Id }
        - role: { _eq: editor }
```

Hasura resolves one role per request from `x-hasura-role`, but a membership is per
organization — owner in Org A, viewer in Org B. Rather than sync JWT claims against membership
changes, every authenticated user is granted all three roles as *allowed*, and the row filter
decides whether they actually hold the one they claimed. A viewer sending
`x-hasura-role: owner` gets the owner permission set and matches zero rows. Nothing to keep in
sync, and no trust placed in a client header.

Because the filter is data-driven, cross-org isolation survives ID guessing: an Org B user
naming an Org A workflow gets `null`, not a permission error. An error would confirm the row
exists, so `null` and `[]` are the only acceptable answers — a rule the probe suite enforces.

**Layer 2 — step-level gating — splits into two sub-cases with two mechanisms**, because they
are structurally different acts.

*Authoring* a `db_write` or `notify` step, or a `webhook` trigger, is a row write, so it is an
insert/update `check` on the row's own type. The subtlety is that the gate must appear in both
halves of an update rule: `filter` is the pre-image (you may not edit an existing privileged
step) and `check` is the post-image (you may not retype a permitted step into a privileged
one). With only the filter, an editor selects an `http_request` step and updates its
`step_type` to `db_write` — a hole that every other probe passes over. `verify-gating`
attempts exactly that retype, because it is the only probe that distinguishes a correct rule
from a filter-only one.

*Clearing an `approval_gate`* cannot be a row permission at all, for three reasons: it depends
on run state, it must resume execution afterwards, and the gate narrows its own approvers
through per-step `config.allowed_roles`, which is data a static rule cannot consult. So no role
has insert or update permission on `step_runs`, which makes the `approveStep` Action the only
door — and that handler re-derives the caller's role from `org_members` rather than trusting
the role in the request. That distinction is not theoretical: every JWT carries all three roles
as allowed, so a viewer can send `x-hasura-role: editor` and pass the Action's own permission.
Only the handler's membership lookup refuses them.

## How pause and resume work

`triggerWorkflowRun` authorizes the caller, checks quota, creates the run **and every
`step_run` as `pending` in one transaction**, then executes. Inserting the whole ladder up
front means the subscription renders it from its first frame rather than materialising rows one
at a time.

The engine walks steps in order. Reaching an `approval_gate` it does not execute anything: one
mutation sets the step to `awaiting_approval` and the run to `paused` with
`resume_from_step_order`, and it returns. Both updates are root fields of a single mutation, so
the run and the step cannot disagree about whether it is paused.

`approveStep` fetches the step run *together with* the caller's membership in one query — an
Org B caller holding a real `step_run_id` gets an empty members array and a "not found" that
never confirms the row exists. It checks the role against that membership row, honours
`config.allowed_roles`, then claims the transition with an update conditional on
`status = 'awaiting_approval'` and branches on `affected_rows`. Two approvers clicking at once
therefore produce one approval and one clean `409`, not two resumes. It then calls the same
`executeRun`, which picks up from `resume_from_step_order`. There is no second execution path.

Resume needs earlier step outputs to resolve `{{steps.N.output.text}}`, and those are rebuilt
from `step_runs` on entry rather than read from the run's stored context. The rows are written
as each step finishes, while the context column is only rewritten when a run ends — so reading
the context back left a resumed run unable to resolve its own templates. Rebuilding from
`step_runs` also means a crash mid-run loses nothing.

Every state transition in the engine is a guarded conditional update reporting
`affected_rows`, so a redelivered webhook, a double-clicked button, or an approval racing a
retry cannot execute a step twice; whoever loses the claim returns `busy` instead of running.

## Deliberate scope cuts

`notify` enqueues a `notifications` row and no delivery handler exists; cron and
database-event triggers are not implemented, since the webhook already satisfies "one trigger
beyond manual"; and there is no scheduler, so a run exceeding its wall-clock budget fails
loudly rather than being left `running` forever. The upgrade path for the last one is a cron
sweep over runs whose `heartbeat_at` has gone stale, resuming from `resume_from_step_order` —
which the schema and the resume path already support.
