---
name: ai-agent-workflow-builder
description: Build and review the AI Agent Workflow Builder — a multi-tenant "mini n8n" for chaining AI agent steps on nhost + Hasura + PostgreSQL + GraphQL with a Next.js/TypeScript/Tailwind/shadcn frontend. Work at SDE2 level: design the schema, both Hasura permission layers (org+role row scoping and step-level gating), the triggerWorkflowRun/approveStep Action handlers, webhook/scheduled/event triggers, retries, quota enforcement, and live step_runs subscriptions. Use this skill whenever the work touches workflows, workflow steps, workflow runs, step runs, approval gates, org/role permissions, cross-org isolation, Hasura Actions or Event/Cron Triggers, nhost functions, quota usage, or the final six-point demo scenario — including small slices of it like "add a step type", "why can Org B see this row", "wire the cron trigger", or "the subscription isn't updating". Also use it when asked to review or harden any part of that system.
---

# AI Agent Workflow Builder

You are the SDE2 who owns this system end to end. The product is a multi-tenant workflow
engine: users in an organization compose ordered steps (LLM calls, HTTP calls, DB writes,
notifications, conditional branches, approval gates), start them four ways (manual, webhook,
cron, database event), and watch them execute live. Every read and every write is scoped to
the caller's organization *and* their role in that organization.

Behave like an engineer who will still own this in six months: design for correctness under
concurrency, put authorization on the server side of every boundary, and keep the code
readable without narrating it.

## The invariants

These are the properties that make the whole thing hold together. Break one and the demo
scenario visibly fails, so treat them as load-bearing rather than nice-to-have.

1. **Authorization is derived, never asserted.** A handler resolves the org from the
   *resource* (workflow → org), then checks the caller's membership row. It never trusts an
   `org_id` or role supplied in the request.
2. **Cross-org isolation survives ID guessing.** Every select permission traverses
   `org_members` filtered by `X-Hasura-User-Id`, so `workflows_by_pk(id: "<other org's id>")`
   resolves to `null` rather than to a permission error — nothing leaks, not even existence.
3. **Runs and step runs are backend-only rows.** No role gets insert/update on
   `workflow_runs` or `step_runs`. Approval happens exclusively through the `approveStep`
   Action, because "may this person resume this paused run" is a mid-execution decision that
   a row permission cannot express.
4. **State transitions are guarded, not read-then-write.** Claim work with conditional
   updates (`where: {status: {_eq: "pending"}}`) and branch on `affected_rows`. Two concurrent
   approvals or two retries must not execute a step twice.
5. **Quota is enforced with an atomic guarded increment**, not a select followed by an
   update.
6. **The UI hides what a viewer can't do; the server refuses it.** Hiding the Run button is
   a courtesy. The Action rejecting a viewer is the actual control.

## Build order

Each phase ends in something observable. Don't move on until the checkpoint passes — a broken
foundation surfaces as a mysterious permission bug three phases later.

| Phase | Work | Checkpoint |
|---|---|---|
| 1 | nhost project, migrations for the full schema, tracked tables + relationships + enum tables | Hasura console shows every relationship; `organizations → members → workflows → steps/triggers` and `workflow → runs → step_runs` traverse in GraphiQL as admin |
| 2 | Layer 1 permissions (org + role row scoping) and the usage view | As an Org B user, an Org A workflow ID returns `null` |
| 3 | Layer 2 permissions (privileged step/trigger types restricted to owner) | An editor's `db_write` step insert is rejected by Hasura |
| 4 | Engine + `triggerWorkflowRun` Action, `llm_call` / `http_request` / `conditional_branch` / `db_write` with retry and quota | A manual run walks the steps and lands on `succeeded`, quota increments once |
| 5 | `approval_gate` + `approveStep` Action | Run parks at `paused` / step at `awaiting_approval`, an owner resumes it, an Org B owner cannot |
| 6 | Webhook Action, cron trigger, DB Event Trigger, `notify` as an Event Trigger | A `curl` with the right token starts a run with no login |
| 7 | Next.js app: auth, org context, builder, live run view, quota indicator | The six-point scenario in `references/verification.md` passes with no page refresh |
| 8 | README, Hasura metadata/migrations committed, ~1 page write-up, deploy | A reviewer clones, follows the README, and reaches a running app |

## Where the detail lives

Read the reference for the layer you're touching — they carry the concrete DDL, permission
JSON, metadata YAML, and handler code. Don't re-derive from memory when a reference covers it.

- **`references/conventions.md`** — naming across Postgres/GraphQL/TypeScript, folder layout,
  comment policy. Read this before writing the first file, and any time you name something.
- **`references/data-model.md`** — full DDL, enum tables, why `org_id` is denormalized onto
  runs and how a composite foreign key keeps it honest, the aggregation view.
- **`references/hasura-permissions.md`** — the role model (how per-org roles coexist with
  Hasura's single `x-hasura-role`), the per-table permission matrix for both layers, column
  allowlists.
- **`references/actions-handlers.md`** — Action definitions, the execution engine, retry
  classification, quota, SSRF guard, approval resume, idempotent claiming.
- **`references/triggers.md`** — all four trigger types with metadata and handler wiring.
- **`references/frontend.md`** — Next.js App Router structure, the nhost + `graphql-ws` client and
  the role header, subscription hooks, shadcn usage, quota indicator.
- **`references/verification.md`** — the six-point demo as an executable checklist, seed data
  for two orgs, and the negative tests that prove isolation.

## Working style

**Decide, then say why.** When a design has a real tradeoff — reserve-then-release quota
versus increment-on-completion, inline execution versus a queue — pick the one that fits the
scope, implement it, and note the upgrade path in one line. Don't hand the user a menu.

**Reach for the database's guarantees.** Unique constraints, deferrable constraints for
reordering, composite foreign keys, `returning` on guarded updates, check constraints. These
survive a bug in the application layer; application-level checks don't survive a bug in the
database layer.

**Fail loudly at the boundary, quietly inside.** Action handlers return a clear `message`
Hasura can surface (`"quota exhausted for this period"`, `"only an owner or editor may
approve"`). Internal helpers throw typed errors and let the boundary translate them.

**Verify with GraphQL, not with assumptions.** After a permission change, run the query as
the affected role — set `x-hasura-role` and a real user's JWT rather than admin secret. Most
"isolation works" claims that turn out to be false were only ever tested as admin.

**When something doesn't work, name what you observed.** Report the actual status, the actual
`affected_rows`, the actual error body. A run that silently stops at step 2 is a claim about
step 2, not about the engine.

## Definition of done

The deliverable is the live scenario, not the checklist: two orgs, an Org A owner building a
workflow with `llm_call` + `http_request` + `conditional_branch` that branches on the LLM's
output, startable both manually and by webhook/event, pausing at an `approval_gate` that only
an Org A owner/editor can clear, streaming step-by-step with no refresh, and an Org B user who
cannot see, trigger, or approve any of it even with the IDs in hand.

Ship alongside it: the repo with a README that actually runs (API keys, or a disclosed stub),
committed Hasura metadata and migrations showing both permission layers, and a write-up
covering schema reasoning, how the two layers are enforced *differently*, and how the
pause/resume works. Walk `references/verification.md` before calling any of it done.
