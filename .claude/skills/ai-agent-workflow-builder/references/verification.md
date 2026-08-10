# Verification — the six-point scenario

The assignment is graded on one live walkthrough, so treat this as the acceptance test and run it
before claiming any part is finished. Each check below fails visibly if the layer beneath it is
wrong, which is the point — a passing walkthrough is evidence about the whole system, not six
independent claims.

## Seed data

Create four users through nhost Auth (sign-up, or the Auth admin API), then:

```sql
insert into public.organizations (id, name, slug, quota_calls_allowed)
values
  ('11111111-1111-1111-1111-111111111111', 'Org A', 'org-a', 50),
  ('22222222-2222-2222-2222-222222222222', 'Org B', 'org-b', 50);

insert into public.org_members (org_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', '<owner_a_user_id>',  'owner'),
  ('11111111-1111-1111-1111-111111111111', '<editor_a_user_id>', 'editor'),
  ('11111111-1111-1111-1111-111111111111', '<viewer_a_user_id>', 'viewer'),
  ('22222222-2222-2222-2222-222222222222', '<owner_b_user_id>',  'owner');
```

Keep a fifth user who belongs to **both** orgs with different roles (owner in A, viewer in B).
Nothing in the assignment demands it, and it's the single best test of the role model — if the
role header and the row filters are wired correctly this user sees Org A's Run button and not Org
B's, with no code aware of the distinction.

Capture each user's access token for the curl probes:

```bash
curl -s "$NHOST_AUTH_URL/signin/email-password" \
  -H 'content-type: application/json' \
  -d '{"email":"owner-b@example.com","password":"..."}' | jq -r '.session.accessToken'
```

## The demo workflow

Built in Org A by the owner. Five steps, chosen so the branch outcome is legible to someone
watching:

| Order | Type | Config sketch |
|---|---|---|
| 1 | `llm_call` | `"Reply with exactly one word — URGENT or NORMAL. Message: {{trigger.payload.text}}"` |
| 2 | `conditional_branch` | left `{{steps.1.output.text}}`, `contains` `"URGENT"`, then `3`, else `5` |
| 3 | `approval_gate` | `allowed_roles: ["owner", "editor"]` |
| 4 | `http_request` | `GET https://api.github.com/zen` (or any stable public endpoint) |
| 5 | `db_write` | writes the verdict into `step_outputs` |

Triggers: one `manual`, one `webhook`. Add a `notify` step after 4 if you want the Event Trigger
visible in the same run.

Two payloads make the branch self-evident on camera: "the checkout page is completely broken and
we're losing orders" takes the URGENT path through approval, and "just checking in on the roadmap"
skips to step 5 with steps 3 and 4 marked `skipped`.

## The checks

### 1. Two orgs with their own users and roles

Sign in as each of the four users and confirm the workflow list, the org switcher, and the
available controls differ per role. The Org A viewer sees the workflow and its run history with no
Run button.

### 2. An Org A owner builds a 3+ step workflow including the branch

Build it in the UI, not by SQL insert — the builder is part of what's being demonstrated. Then
confirm layer 2 by signing in as the Org A **editor** and trying to add the `db_write` step: it's
disabled in the picker, and if you call the mutation directly Hasura rejects it.

```bash
curl -s "$HASURA_GRAPHQL_URL" \
  -H "Authorization: Bearer $EDITOR_A_JWT" -H 'x-hasura-role: editor' \
  -H 'content-type: application/json' \
  -d '{"query":"mutation { insert_workflow_steps_one(object: {workflow_id: \"'"$WORKFLOW_ID"'\", step_order: 9, step_type: \"db_write\", name: \"sneak\", config: {}}) { id } }"}'
```

Expect a `check constraint` / permission error. Then try the update path — take an existing
`http_request` step and set `step_type: "db_write"`. If that succeeds, the `check` is missing from
the editor's update permission and layer 2 has a hole; see `hasura-permissions.md`.

### 3. Startable two ways

Manual through the Run button, then webhook with `curl` while signed out (see `triggers.md`).
Both produce runs in the same list, distinguishable by `trigger_type`, with `triggered_by` null on
the webhook one. Running the same workflow both ways within the demo is what proves the entry
points share an engine.

### 4. Pauses at the approval gate, cleared only by an Org A owner/editor

Watch the run reach step 3 and stop: run `status = 'paused'`, step `status =
'awaiting_approval'`. Approve as the Org A editor and watch it continue through 4 and 5.

Before approving, try it as the Org B owner with the real `step_run_id`:

```bash
curl -s "$HASURA_GRAPHQL_URL" \
  -H "Authorization: Bearer $OWNER_B_JWT" -H 'x-hasura-role: owner' \
  -H 'content-type: application/json' \
  -d '{"query":"mutation { approveStep(step_run_id: \"'"$STEP_RUN_ID"'\") { status } }"}'
```

Expect "Step run not found" — not "forbidden", which would confirm the row exists. Confirm the run
is still `paused` afterwards and `approved_by` is still null.

Also click approve twice in quick succession from two browsers: one succeeds, one gets `conflict`,
and the run advances once.

### 5. Live status with no refresh

Keep the run page open for the whole execution. Steps transition in place; the paused state
appears without interaction; the quota indicator ticks on completion. If anything needs a refresh,
the subscription is falling back to a poll or the WebSocket is authenticating with the wrong
role — check `connectionParams` before anything else.

### 6. Org B cannot see, trigger, or approve

Run every probe as the Org B owner with real Org A IDs in hand.

```bash
probe() {
  curl -s "$HASURA_GRAPHQL_URL" \
    -H "Authorization: Bearer $OWNER_B_JWT" -H 'x-hasura-role: owner' \
    -H 'content-type: application/json' -d "{\"query\":\"$1\"}"
}

probe "query { workflows_by_pk(id: \\\"$WORKFLOW_ID\\\") { id name } }"
probe "query { workflow_steps(where: {workflow_id: {_eq: \\\"$WORKFLOW_ID\\\"}}) { id step_type } }"
probe "query { workflow_runs_by_pk(id: \\\"$RUN_ID\\\") { id status } }"
probe "query { step_runs(where: {workflow_run_id: {_eq: \\\"$RUN_ID\\\"}}) { id status output } }"
probe "query { org_usage_summary(where: {org_id: {_eq: \\\"$ORG_A_ID\\\"}}) { quota_calls_used } }"
probe "query { org_members(where: {org_id: {_eq: \\\"$ORG_A_ID\\\"}}) { user_id role } }"
probe "mutation { triggerWorkflowRun(workflow_id: \\\"$WORKFLOW_ID\\\") { status } }"
probe "mutation { approveStep(step_run_id: \\\"$STEP_RUN_ID\\\") { status } }"
```

Expected: `null` for the `_by_pk` queries, `[]` for the list queries, and a not-found message for
both mutations. Nowhere should a permission error, a row count, or a field name reveal that the
resource exists.

Then repeat the whole set with `x-hasura-role: editor` and `viewer`, and once with no role header
at all. A filter accidentally left permissive on one of the three roles is the most common way
this check fails, and it's invisible if you only test the role you happened to log in as.

## Beyond the six

These aren't in the walkthrough but are named in the evaluation criteria, so demonstrate them
somewhere — a short section of the recording or a README block with output is enough.

**Retry.** Point an `http_request` step at `https://httpstat.us/503`, run it, and show
`attempt_count = 2` with the step ending `failed` and the run `failed`. Then point it at
`https://httpstat.us/400` and show `attempt_count = 1` — the classification distinguishes
transient from permanent, and a retry count of 2 on a 400 would mean it doesn't.

**Quota.** Set `quota_calls_allowed = 2` on a scratch org, run three times, and show the third
refused with `quota-exhausted` before a run row is created. Confirm a *failed* run didn't consume
quota.

**Cron.** Add a scheduled trigger with `*/5 * * * *`, wait one sweep, and show the run appearing
with `trigger_type = 'scheduled'` and `triggered_by = null`.

**Event trigger.** Insert an `incoming_documents` row as an Org A user and show the run starting.
Then insert one as the Org B owner and show it starting **Org B's** workflows only — the event
handler's org filter is exactly the kind of back-door cross-org bug the main six checks don't
reach.

## Before submitting

- `nhost/migrations/` and `nhost/metadata/` committed, and a clean clone applies them without
  hand edits.
- README: prerequisites, `nhost up`, env vars with what each one is for, how to seed the two orgs,
  demo credentials, and an explicit note if `llm_call` is stubbed.
- Write-up (~1 page): schema reasoning including the denormalized `org_id` and its composite
  foreign key; how layer 1 (row filters traversing `org_members`) and layer 2 (insert/update
  `check` on step type, plus the Action handler's mid-execution role check) are enforced by
  *different mechanisms* and why an approval gate cannot be a row permission; and the pause/resume
  mechanism — `paused` + `resume_from_step_order`, guarded approval claim, resume through the same
  `executeRun`.
- No secrets in the repo. Grep the diff for the admin secret, the LLM key, the webhook secret, and
  any `.env` that isn't `.env.example`.
- Recording covers all six checks in order, with the Org B probes visible on screen.
