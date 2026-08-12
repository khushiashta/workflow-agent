# Demo script

The six points the assignment is graded on, in an order that needs no cuts. All four accounts
use the seeded password. Two browser windows side by side — **left signed in as Org A, right as
Org B** — so the final isolation check needs no signing out.

Before recording: run `ENV_FILE=.env.cloud npm run seed` so the data is clean, and have a
terminal ready for the webhook call.

| Account | Role |
|---|---|
| `owner-a@example.com` | Org A owner |
| `editor-a@example.com` | Org A editor |
| `viewer-a@example.com` | Org A viewer |
| `owner-b@example.com` | Org B owner |

## 1. Two organizations, own users and roles

Left window, sign in as **owner-a**. Point out the org switcher reading *Org A · owner* and the
quota indicator. Open the switcher to show the role travels with the organization.

Right window, sign in as **owner-b**. Switcher reads *Org B · owner*, and the workflow list is
empty — a different tenant, same app.

## 2. An owner builds a workflow with three step types

As **owner-a**, create a workflow (name it something like `Escalation triage`) and add five
steps:

| # | Type | What to set |
|---|---|---|
| 1 | LLM call | leave the default prompt — it classifies `{{trigger.payload.text}}` as URGENT or NORMAL |
| 2 | Conditional branch | left `{{steps.1.output.text}}`, `contains`, `URGENT`, then → 3, else → 5 |
| 3 | Approval gate | leave owner and editor checked |
| 4 | HTTP request | `GET https://api.github.com/zen` |
| 5 | Database write | label `triage_verdict` |

Save.

**Then show layer 2.** Sign in as **editor-a** in a third tab (or reuse the right window) and
open the same workflow: the *Add a step* dropdown shows *Database write — owner only* and
*Notify — owner only*, disabled, with the reason. Worth saying out loud that this is a Hasura
insert **and update** check, not a hidden button — an editor cannot retype an existing step into
a privileged one either.

## 3. Started two ways

**Manually:** back as **owner-a**, click **Run**, keep the default urgent payload, confirm.

**By webhook:** in the Triggers panel click **Create webhook**, copy the token (shown once —
only its hash is stored), then from a terminal, with no login at all:

```bash
curl -s "$NHOST_GRAPHQL_URL" -H 'content-type: application/json' -d '{
  "query": "mutation ($id: uuid!, $token: String!, $payload: jsonb) { startWorkflowRunViaWebhook(workflow_id: $id, token: $token, payload: $payload) { workflow_run_id status } }",
  "variables": {
    "id": "<workflow id from the URL>",
    "token": "<the token you copied>",
    "payload": { "text": "just checking in on the roadmap" }
  }
}'
```

Use the *non*-urgent text here — it takes the else branch and finishes without pausing, which
demonstrates the branch actually branching. Open that run: steps 3 and 4 are marked **not
taken**, and step 2 shows `evaluated "NORMAL" → false`.

Worth showing a wrong token too — it returns `Invalid webhook token`.

## 4. It pauses, and only the right roles can clear it

Open the manual run from step 3. It sits at **paused**, step 3 at **awaiting approval**, steps 4
and 5 still pending, and the amber panel names who may approve.

**Show the refusal first.** In the right window as **owner-b**, paste the run URL from Org A.
The page says *"This run is not available"* — a real ID, and it resolves to nothing.

Then approve as **owner-a** (or editor-a) with a comment. Both roles are allowed here; the
`allowed_roles` field on the gate can narrow it to owner only.

## 5. Live, with no refresh

This is the same moment as step 4 — do not reload anything. On approving:

- the approval panel disappears
- the run badge goes **paused → succeeded**
- steps 4 and 5 stream in with their durations
- step 3 shows *approved by Ava Owner — "your comment"*
- **the quota indicator in the header ticks up**

The green **live** dot next to the status badge is the subscription. Everything on that page
arrives over two WebSocket subscriptions — one on the run, one on its step runs.

## 6. Org B cannot see, trigger, or approve any of it

In the right window as **owner-b**, with Org A's real IDs:

- paste the Org A **workflow** URL → *not available*
- paste the Org A **run** URL → *not available*
- the workflow list stays empty

Then close it off from the terminal, which is stronger than the UI because it bypasses the
frontend entirely:

```bash
ENV_FILE=.env.cloud npm run verify:isolation
```

84 probes: every read an Org B user could attempt against Org A's IDs, under all four roles it
could put in the header, plus positive controls from inside Org A to prove the probes aren't
passing because everything is empty.

## Worth a closing 30 seconds

```bash
ENV_FILE=.env.cloud npm run verify:all
```

155 checks against the deployed backend — retry classification (a timeout retries, a 404 does
not), the SSRF guard refusing link-local addresses, quota refusing a run before it creates a
row, the double-approval race resolving to one approval and one conflict.
