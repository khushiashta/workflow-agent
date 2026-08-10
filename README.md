# AI Agent Workflow Builder

A multi-tenant workflow engine for chaining AI agent steps — a mini n8n. Users in an organization
compose ordered steps (LLM calls, HTTP calls, DB writes, conditional branches, approval gates),
start them manually or by webhook, and watch execution stream live. Every read and write is scoped
to the caller's organization *and* their role in it.

Built on nhost (PostgreSQL + Hasura + Auth + Functions) with a Next.js frontend.

> **Status:** schema, relationships, and seed are in place. Permissions, the execution engine,
> and the UI are next.

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
for the acceptance test, not a convenience. Credentials print to stdout.

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

- `docs/write-up.md` — schema reasoning, how the two permission layers differ, and how the
  approval gate pauses and resumes *(added in H10)*
