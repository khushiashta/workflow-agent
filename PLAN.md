# 10-Hour Build Plan — AI Agent Workflow Builder

## Context

The assignment is graded on one live 6-point scenario, not a feature checklist. Everything here
is scoped to make those six points hold under a reviewer who will paste an Org A ID into an Org B
session. Anything that doesn't serve them is cut explicitly and disclosed in the README.

The repo is currently empty except `.claude/skills/ai-agent-workflow-builder/`, which holds the
DDL, permission JSON, and handler code this plan executes. Read the relevant reference at the
start of each block rather than re-deriving — that's what it's for.

**Division of labour:** I write all code, migrations, metadata, and docs. You hold the mental
model and review. Four things need you specifically, marked **[YOU]** below: nhost Cloud signup,
Vercel signup, the Groq key, and the final recording.

## Deliberate deviations from the skill

Recorded here so they read as decisions, not drift. All three go in the write-up.

| Skill says | We do | Why |
|---|---|---|
| Enum reference tables (6 tables, tracked as Hasura enums) | `text` columns + `CHECK` constraints, TS const unions on the client | 6 tables × (track + `is_enum` + 3 select perms) ≈ 30 min of metadata for zero scenario value |
| `notify` delivered by an Event Trigger | `notify` step inserts a `notifications` row, no delivery handler | Slack wiring serves none of the six points; the row proves the step type exists |
| Cron trigger + DB event trigger | Webhook only | "At least one trigger beyond manual" — webhook is the cheapest and the most demoable |

**Kept despite the time pressure**, because they're what a reviewer probes: denormalized `org_id`
on `workflow_runs` pinned by a composite FK, `deferrable initially deferred` unique on
`(workflow_id, step_order)`, the `org_usage_summary` view, guarded conditional updates for every
state transition, and the SSRF guard on `http_request`.

## Hour blocks

Each block ends in a checkpoint that fails loudly. Do not start the next block until it passes —
a bad foundation here resurfaces as an unexplainable permission bug three blocks later. Each
block is budgeted at ~50 min of work with ~10 min slack.

### H1 — Accounts, skeleton, and a proven deploy pipeline

- **[YOU]** nhost Cloud account + free project (note subdomain and region); Vercel account;
  Groq key from console.groq.com.
- `nhost init` (generates the `nhost/` config — don't hand-write it), `nhost link` to the cloud
  project, connect the GitHub repo so pushes apply migrations/metadata and deploy functions.
- `create-next-app` into `web/` (TypeScript, Tailwind, App Router, `@/*` alias) +
  `shadcn init` + the component set listed in `references/frontend.md`.
- Configure nhost auth allowed roles: default `user`, allowed
  `["user", "me", "owner", "editor", "viewer"]`.
- Push, and deploy `web/` to Vercel as-is.

**Checkpoint:** a hello-world Next.js page is live on a Vercel URL, and `nhost up` boots Postgres
+ Hasura + functions locally. Deploying for the first time at hour 10 is the standard way this
assignment dies; the pipeline exists now.

### H2 — Schema migration and seed

- One migration, `nhost/migrations/default/<ts>_init/{up,down}.sql`, from
  `references/data-model.md`: `organizations`, `org_members`, `workflows`, `workflow_steps`,
  `workflow_triggers`, `workflow_runs`, `step_runs`, plus `step_outputs`, `notifications`, the
  `set_current_timestamp_updated_at` trigger, the `consume_org_quota(uuid)` function, and the
  `org_usage_summary` view. Status/type columns as `text` + `CHECK`.
- `scripts/seed.ts`: creates 4 users via the Auth signup endpoint (owner_a, editor_a, viewer_a,
  owner_b), 2 orgs, 4 memberships. Idempotent — you will run it many times.

**Checkpoint:** in local GraphiQL as admin, one query traverses
`organizations → members → workflows → runs → step_runs`. Seed prints the 4 user IDs and 2 org
IDs; save them in `scripts/demo-ids.md` for the curl probes.

### H3 — Track tables, relationships, Layer 1 permissions

- Track all tables + the view in the console, accept the auto-suggested FK relationships, add
  the manual object relationship `org_usage_summary.organization`, then export metadata.
- Hand-edit `nhost/metadata/databases/default/tables/*.yaml` for permissions — 3 roles × 8 tables
  through the console UI is slow and error-prone, and the YAML is what gets committed anyway.
  Every filter traverses `org_members` on `X-Hasura-User-Id` per
  `references/hasura-permissions.md`. `workflow_runs` and `step_runs` get **select only**.
- Exclude `quota_calls_used` / `quota_calls_allowed` from every update column list, and
  `webhook_secret_hash` from every select.

**Checkpoint (this is demo point 6, five hours early):** sign in as owner_b via curl, set
`x-hasura-role: owner`, query `workflows_by_pk` with Org A's ID → `{"data":{"workflows_by_pk":null}}`.
Repeat for `workflow_runs_by_pk`, `step_runs`, `org_usage_summary`, `org_members`, and with roles
`editor` and `viewer`.

**Gotcha to check here explicitly:** decode a seeded user's JWT and confirm
`x-hasura-allowed-roles` actually contains `owner`/`editor`/`viewer`. If the H1 role config
didn't take, every request resolves as `user`, every permission matches nothing, and the app
looks catastrophically broken for a reason that has nothing to do with the permissions.

### H4 — Layer 2 permissions, then Action scaffolding

- Editor `insert` **and** `update` on `workflow_steps` get
  `step_type: {_nin: [db_write, notify]}`; `workflow_triggers` gets
  `trigger_type: {_nin: [webhook]}`. The `check` on update is the one people forget — without it
  an editor retypes an existing `http_request` step into a `db_write`.
- `functions/_lib/`: `admin-client.ts`, `errors.ts`, `authorization.ts`, `quota.ts`, `retry.ts`,
  `template.ts` — all specified in `references/actions-handlers.md`.
- `metadata/actions.graphql` + `actions.yaml` for all three Actions; `triggerWorkflowRun` returns
  a hard-coded response for now.

**Checkpoint:** as editor_a, inserting a `db_write` step is rejected, and updating an existing
`http_request` step's `step_type` to `db_write` is also rejected. `triggerWorkflowRun` is callable
through Hasura and returns its stub.

### H5 — Engine, `llm_call`, `http_request`, retry, quota

- `_lib/engine.ts`: claim run → loop steps → claim step → execute → persist → advance. Every
  transition a conditional update branching on `affected_rows`. Insert all `step_runs` as
  `pending` when the run is created so the subscription renders the full ladder from frame one.
- `_lib/steps/llm-call.ts` (Groq, `AbortSignal.timeout`, stub fallback flagged
  `output.stubbed`), `http-request.ts` (with the private-IP guard), `db-write.ts`,
  `notify.ts` (row insert only).
- Real `triggerWorkflowRun`: `requireUserId` → `authorizeWorkflowAccess(['owner','editor'])` →
  `assertQuotaAvailable` → create run → `executeRun` → `consumeQuota`.

**Checkpoint:** a hand-seeded 2-step workflow (`llm_call` → `http_request`) runs to `succeeded`
with real outputs in `step_runs`. `quota_calls_used` goes up by exactly 1. As viewer_a the Action
returns a role error; as owner_b it returns "Workflow not found".

### H6 — `conditional_branch`, pause, `approveStep`

- `conditional-branch.ts` returns `nextStepOrder` and persists `evaluated_left` + `matched`;
  bypassed steps marked `skipped`.
- Approval gate handled in the engine: run → `paused` with `resume_from_step_order`, step →
  `awaiting_approval`, both in one mutation so they can't disagree.
- `approveStep`: fetch the step run *with* the caller's membership in one query → role check
  against the membership row (honouring `config.allowed_roles`) → guarded claim on
  `status = awaiting_approval` → `executeRun` resumes.

**Checkpoint (demo point 4):** the 5-step demo workflow pauses at step 3. Approving as editor_a
resumes it through 4 and 5. As owner_b with the real `step_run_id` → "Step run not found", and the
run is still `paused` with `approved_by` null. Two simultaneous approvals → one succeeds, one gets
`conflict`, run advances once.

### H7 — Webhook trigger, then cloud parity

- Token minted server-side on trigger creation, returned once, stored as a SHA-256 hex hash;
  verified with `timingSafeEqual`. `startWorkflowRunViaWebhook` is `public`-role and shares
  `createRun` + `executeRun` with the manual path.
- Push to nhost Cloud. Set `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, `NHOST_WEBHOOK_SECRET` in
  the dashboard. Seed the two orgs against cloud.

**Checkpoint (demo point 3):** `curl` against the **cloud** GraphQL endpoint with no auth header
and a valid token starts a run; a wrong token gets "Invalid webhook token". Then re-run the H3
Org B probes against cloud — metadata that applied locally can fail to apply in the cloud, and
finding that out now costs 20 minutes instead of the submission.

### H8 — Frontend: auth, org context, builder

- `app/providers.tsx`: nhost + Apollo, with `x-hasura-role` set from the active membership on
  both the HTTP link and the WS `connectionParams`, and the provider keyed on active org id so
  switching orgs reconnects the socket.
- Sign-in, `(app)` layout with org switcher + quota indicator, `/workflows` list
  (`OrgWorkflowsWithLatestRun`), `/workflows/[id]` builder: add step (type dropdown), reorder with
  up/down buttons, config form per type, trigger attach, webhook token shown once.
- `lib/workflow/permissions.ts` — one module, all role predicates.

**Checkpoint (demo points 1 and 2):** owner_a builds the 5-step demo workflow entirely in the UI.
editor_a sees `db_write` disabled with a tooltip. viewer_a sees no Run button and no edit
controls.

### H9 — Frontend: live run view, approval, quota

- `/runs/[id]`: two subscriptions (one on the run for `status`, one on `step_runs`) — nesting them
  would re-push every step on any run change. Status treatment per step per
  `references/frontend.md`, showing `attempt_count`, `error`, and the branch's `evaluated_left`.
- Approval panel when `awaiting_approval` and role permits; no optimistic update — the
  subscription delivers the transition. `conflict` shown as information, not failure.
- Run button gated on role and remaining quota; Action errors mapped by `extensions.code`.

**Checkpoint (demo point 5):** run from the UI and watch it stream through pause → approve →
completion with no refresh, quota ticking at the end.

### H10 — Ship

- Redeploy `web/` to Vercel with the cloud nhost env vars. Fresh seed so demo credentials are
  clean.
- README: prerequisites, setup, env var table with what each is for, seed command, the 4 demo
  logins, and the three disclosed cuts.
- Write-up (~1 page): schema reasoning incl. the denormalized `org_id` + composite FK; Layer 1
  (row filters through `org_members`) vs Layer 2 (insert/update `check` on step type **plus** the
  handler's mid-execution role check) and why an approval gate cannot be a row permission; the
  pause/resume mechanism.
- **[YOU]** Record the six checks in order, Org B probes visible on screen. One take, no editing.

## If you're behind

Cut in this order. The first four cost nothing that's graded.

1. Drag-to-reorder → already planned as up/down buttons; don't reintroduce `@dnd-kit`.
2. `notify` step entirely — no demo point needs it.
3. Builder edit-in-place → create-only, plus delete-and-recreate a step.
4. `llm_call` → stub with a disclosed 1s delay (also removes a live-demo failure mode).
5. viewer_a user → assert role gating via the Action's error instead of in the UI.
6. Write-up → tight bullets rather than prose.

**Never cut:** the `org_members` traversal in every filter, the Org B probe set, the approval gate
and its handler-side role check, the `step_runs` subscription, the webhook trigger. Those five
*are* the assignment.

## Verification

The full acceptance test is `references/verification.md` — run it, don't approximate it. The parts
that matter most:

- **Isolation:** the `probe()` helper in that file, run as owner_b against every Org A ID, for all
  three role headers and with none. Expect `null` / `[]` / "not found" — never a permission error,
  which would confirm existence.
- **Layer 2:** editor_a rejected on both the insert and the update path for `db_write`.
- **Retry classification:** `http_request` at `https://httpstat.us/503` → `attempt_count = 2`;
  at `https://httpstat.us/400` → `attempt_count = 1`.
- **Quota:** scratch org with `quota_calls_allowed = 2`, three runs, third refused with
  `quota-exhausted` before a run row exists; a failed run consumes nothing.
- **Liveness:** the run page open across a full pause → approve → finish cycle with no refresh.

Every check runs against the **deployed** cloud backend before recording. Passing locally is not
evidence about what the reviewer will open.
