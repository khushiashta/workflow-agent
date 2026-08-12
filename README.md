# AI Agent Workflow Builder
(IMPORTANT NOTE: There's a video demo of this in above file named "Workflow-Video-Demo.zip" as there was some issue with uploading the video file in submission)
A multi-tenant workflow engine for chaining AI agent steps — a mini n8n. Users in an organization
compose ordered steps (LLM calls, HTTP calls, DB writes, conditional branches, approval gates),
start them manually or by webhook, and watch execution stream live. Every read and write is scoped
to the caller's organization *and* their role in it.

Built on nhost (PostgreSQL + Hasura + Auth + Functions) with a Next.js frontend.

**155 automated checks pass against the deployed backend** — both permission layers, the engine,
retry classification, the SSRF guard, quota, the approval gate including its double-approval
race, and the unauthenticated webhook path. Run them yourself: see [Verification](#verification).

## Stack

| Layer | Choice |
|---|---|
| Database | PostgreSQL (nhost) |
| API | Hasura GraphQL — queries, mutations, subscriptions, Actions |
| Auth | nhost Auth (JWT with Hasura claims) |
| Handlers | nhost Functions (Node 22, TypeScript) |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, shadcn/ui |
| LLM | Groq (OpenAI-compatible), with a disclosed stub fallback |

## Layout

```
.
├── nhost/
│   ├── nhost.toml            project config (auth roles, versions, Hasura settings)
│   ├── migrations/default/    committed SQL migrations
│   └── metadata/              tracked tables, relationships, permissions, actions
├── functions/                 nhost functions — route mirrors the file path
│   ├── actions/               triggerWorkflowRun, approveStep, webhook entry point
│   ├── events/                Hasura Event Trigger handlers
│   └── _lib/                  shared code; the underscore keeps it unrouted
├── scripts/                   seed and operational scripts
└── web/                       Next.js app
```

## Local setup

```bash
git clone <repo> && cd <repo>
npm install && npm --prefix web install
cp .env.example .env
cp web/.env.example web/.env.local
```

Then start the backend and the frontend:

```bash
nhost up
npm --prefix web run dev
```

`nhost up` needs a Docker daemon. `nhost` itself installs without one:

```bash
curl -L https://raw.githubusercontent.com/nhost/cli/main/get.sh | bash
```

On macOS without Docker Desktop, Colima works and needs no admin password:

```bash
brew install colima docker docker-compose
colima start --cpu 4 --memory 6 --disk 40
mkdir -p ~/.docker/cli-plugins
ln -sfn "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
```

The symlink is the part that isn't obvious: brew installs Compose as a standalone binary,
while the nhost CLI shells out to `docker compose` as a plugin subcommand. Without it,
`nhost up` fails with `unknown flag: --project-directory`, which reads like a CLI version
problem rather than a missing plugin.

Local service URLs once up: GraphQL at `https://local.graphql.local.nhost.run/v1`, Auth at
`https://local.auth.local.nhost.run/v1`, Hasura console at `http://localhost:9695`. Local dev
secrets live in `.secrets` (gitignored, well-known defaults — never reused in the cloud).

### Seed the demo organizations

```bash
npm run seed
```

Creates two organizations and four users — an owner, editor, and viewer in Org A, and an owner in
Org B. Cross-org isolation is unprovable without at least two tenants, so this is a prerequisite
for the acceptance test, not a convenience.

| Account | Organization | Role |
|---|---|---|
| `owner-a@example.com` | Org A | owner |
| `editor-a@example.com` | Org A | editor |
| `viewer-a@example.com` | Org A | viewer |
| `owner-b@example.com` | Org B | owner |

All four share `SEED_USER_PASSWORD`. The script is idempotent, and it preflights the backend
before writing anything: it fails with the fix, not the symptom, when the schema is missing, the
admin secret is wrong, or the project does not grant `owner`/`editor`/`viewer` as JWT roles.
That last one is worth a check of its own — without those roles every permission matches zero
rows and the app looks broken for a reason that has nothing to do with permissions.

## Verification

The backend contract is provable from the command line. Each suite creates and removes its
own fixtures, so they are safe to re-run and safe to point at the deployed backend.

```bash
npm run verify:all
```

| Suite | Covers |
|---|---|
| `verify:isolation` | Every read an Org B user could attempt against Org A's real ids, under each role, plus positive controls from inside Org A |
| `verify:gating` | Layer 2 — privileged step types and webhook triggers are owner-only, including the retype attempt |
| `verify:engine` | Execution, retry classification, the SSRF guard, quota |
| `verify:approval` | Pause, resume, cross-org refusal, the double-approval race |
| `verify:webhook` | Token minting, unauthenticated entry, rotation, quota on the anonymous path |

Two conventions in these suites are deliberate. **Positive controls are included** — a suite
where every probe returns nothing passes the negative cases for the wrong reason and looks
identical to one where the rules work. And **a permission error counts as a failure** even
though it denies access, because an error confirms the row exists; `null` and `[]` are the
answers that reveal nothing.

## Starting a run from outside

`triggerWorkflowRun` is the in-app path. For external systems, an owner mints a token once:

```bash
mutation { createWebhookTrigger(workflow_id: "...") { workflow_trigger_id token } }
```

The plaintext is returned exactly once and only a SHA-256 hash is stored, so reading the
`workflow_triggers` row is not the same as holding the credential. Calling it again rotates
the token and the previous one stops working immediately. Then, with no session at all:

```bash
curl -s "$NHOST_GRAPHQL_URL" -H 'content-type: application/json' -d '{
  "query": "mutation ($id: uuid!, $token: String!, $payload: jsonb) { startWorkflowRunViaWebhook(workflow_id: $id, token: $token, payload: $payload) { workflow_run_id status } }",
  "variables": {
    "id": "<workflow id>",
    "token": "<token from createWebhookTrigger>",
    "payload": { "text": "the checkout page is completely broken and we are losing orders" }
  }
}'
```

The payload lands in `workflow_runs.context.trigger.payload`, reachable from step configs as
`{{trigger.payload.text}}` — which is how one workflow behaves differently per caller without
being edited. Quota applies exactly as it does to a manual run; an unauthenticated endpoint
exempt from quota would be a free amplifier.

## Environment

Backend (`.env` locally, project environment variables in nhost Cloud):

| Variable | Purpose |
|---|---|
| `NHOST_GRAPHQL_URL` | Injected at runtime in nhost; set locally for scripts |
| `NHOST_AUTH_URL` | Same — used by the seed script to create users |
| `NHOST_ADMIN_SECRET` | Lets handlers bypass permissions after they authorize the caller themselves |
| `NHOST_WEBHOOK_SECRET` | Shared secret Hasura sends on Event/Cron calls; handlers fail closed if unset |
| `LLM_API_KEY` | Groq key. Empty ⇒ the `llm_call` step falls back to the disclosed stub |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` |
| `LLM_MODEL` | `llama-3.3-70b-versatile` |
| `SEED_USER_PASSWORD` | Password for the four demo users (min 9 chars) |

Frontend (`web/.env.local`, and the same keys in Vercel):

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_NHOST_SUBDOMAIN` | `local` for `nhost up`, else the cloud subdomain |
| `NEXT_PUBLIC_NHOST_REGION` | Blank locally, else the cloud region |

## Deployment

The Next.js app deploys to Vercel with **Root Directory** set to `web`. The backend deploys to
nhost Cloud from the connected GitHub repo — a push applies `nhost/migrations` and
`nhost/metadata` and redeploys `functions/`. Backend secrets are set in the nhost dashboard, not
in the repo.

### Project secrets, before the first deploy

This is the step that will bite you. `nhost/nhost.toml` resolves `{{ secrets.X }}` **from the
cloud project's own secrets**, and the `.secrets` file in this repo only feeds `nhost up`. A fresh
project therefore has none of them, and the deployment fails at *Project Config* on the first
unresolved reference — skipping migrations, metadata and functions, so the symptoms look like
three unrelated problems at once.

Generate them and upload:

```bash
./scripts/generate-cloud-secrets.sh
while IFS='=' read -r name value; do
  case "$name" in ''|'#'*) continue;; esac
  nhost secrets create "$name" "$value" || nhost secrets update "$name" "$value"
done < .cloud-secrets.local
```

The script writes values to a gitignored file rather than printing them, and rewrites
`NHOST_ADMIN_SECRET` in `.env.cloud` to match — the project's admin secret *becomes* whatever
`HASURA_GRAPHQL_ADMIN_SECRET` holds once the config applies, so the two have to agree.

Five secrets are needed: `HASURA_GRAPHQL_ADMIN_SECRET`, `HASURA_GRAPHQL_JWT_SECRET`,
`NHOST_WEBHOOK_SECRET`, `GRAFANA_ADMIN_PASSWORD`, and `LLM_API_KEY` (your Groq key — without it
`llm_call` falls back to the stub and marks its output `stubbed: true`). `LLM_BASE_URL` and
`LLM_MODEL` come from `nhost.toml` and need no entry.

One thing not to add: `HASURA_GRAPHQL_UNAUTHORIZED_ROLE`. nhost already sets it to `public`, and
the cloud config schema rejects reserved `HASURA_*` names in `global.environment` — while the
local CLI validates that more loosely, so it passes `nhost config validate` and then fails the
deploy.

### Verifying the deployed backend

Passing locally is not evidence about what a reviewer will open — metadata that applies
locally can still fail in the cloud. Point the same suites at the deployment:

```bash
cp .env.cloud.example .env.cloud   # fill in NHOST_ADMIN_SECRET and SEED_USER_PASSWORD
ENV_FILE=.env.cloud npm run seed
ENV_FILE=.env.cloud npm run verify:all
```

The suites create their own organizations and workflows and delete them afterwards, so this is
safe against a live project. `seed` is idempotent.

## Notable decisions

**No Apollo Client, no `@nhost/react`.** `@nhost/react-apollo` declares peer support for React
17/18 only, and `@nhost/react` pins `@nhost/nhost-js@3.3.1` — neither works on Next 16 / React 19.
Rather than pin the whole app to an old React, the GraphQL layer is `@nhost/nhost-js@4` for auth
and one-shot operations plus `graphql-ws` for subscriptions. The app needs two queries, three
mutations, and two subscriptions; a client-side cache buys little when subscriptions already drive
every live surface.

**Auth config, two deliberate changes** in `nhost/nhost.toml`: `auth.user.roles.allowed` gains
`owner`, `editor`, and `viewer` so a JWT can carry them, and `emailVerificationRequired` is off so
seeded demo users can sign in without an inbox. The first is load-bearing — without it every
request resolves as role `user`, every permission written for the three roles matches nothing, and
the app fails in a way that looks nothing like a role-config problem.

Role selection deserves a note. Hasura resolves one role per request from `x-hasura-role`, but a
user's role is per organization — owner in Org A, viewer in Org B. Every permission for a role
additionally requires a matching `org_members` row, so granting all three roles to every user is
safe: the header selects which permission set applies and the database decides whether the caller
actually holds it. Nothing to keep in sync when membership changes.

## Documentation

- [docs/write-up.md](docs/write-up.md) — schema reasoning, how the two permission layers are
  enforced by *different mechanisms*, and how the approval gate pauses and resumes
- [docs/demo-script.md](docs/demo-script.md) — the six-point walkthrough, click by click
