# Conventions

One rule underlies all of these: a name should be predictable from the layer it lives in. A
reader who sees `workflow_run_id` knows it came from Postgres; one who sees `workflowRunId`
knows it's TypeScript. Mixing the two forces everyone to remember which files broke the rule.

## Postgres

| Thing | Convention | Example |
|---|---|---|
| Table | `snake_case`, plural | `workflow_steps` |
| Column | `snake_case` | `attempt_count` |
| Primary key | `id uuid default gen_random_uuid()` | |
| Foreign key | `<singular_referenced>_id` | `workflow_run_id` |
| Boolean | `is_` / `has_` prefix | `is_enabled` |
| Timestamp | `_at` suffix, `timestamptz` | `approved_at` |
| Enum reference table | `snake_case`, plural of the concept | `step_types` |
| Index | let Postgres name it unless it needs to be referenced | |
| Constraint | `snake_case` describing the rule | `quota_used_non_negative` |
| Function | `snake_case`, verb-first | `set_current_timestamp_updated_at()` |

Never abbreviate in schema names — `configuration` vs `config` is a coin flip, but `cfg`,
`wf`, and `usr` cost every future reader a lookup. (`config` is fine as the settled short form
that reads as a word; `id`, `url`, and `jsonb` are established.)

Enum-like values live in reference tables with a `value text primary key` and a `comment text`,
tracked in Hasura as enum tables. Values must be valid GraphQL enum names, so keep them
`lower_snake_case` with no leading digit. Reference tables beat native Postgres enum types here
because adding a value is an `insert` rather than a migration that rewrites the type, and
because Hasura exposes them as real GraphQL enums either way.

## GraphQL

Field names come from Postgres, so they are `snake_case` — leave them that way rather than
configuring Hasura to camelize. Consistency with the migrations matters more than matching
JavaScript, and camelization makes every permission rule and every error message read
differently from the schema it describes.

| Thing | Convention | Example |
|---|---|---|
| Action | `camelCase`, verb-first | `triggerWorkflowRun` |
| Action input type | `<Action>Input` | `ApproveStepInput` |
| Action output type | `<Action>Output` | `TriggerWorkflowRunOutput` |
| Named operation | `PascalCase`, purpose-first | `OrgWorkflowsWithLatestRun` |
| Subscription | `PascalCase`, ends in what it watches | `StepRunsForWorkflowRun` |

Actions are `camelCase` because they are RPC verbs authored by hand, not table-derived names.

## TypeScript

| Thing | Convention | Example |
|---|---|---|
| File / directory | `kebab-case` | `lib/workflow/step-executor.ts` |
| React component file | `kebab-case`, component `PascalCase` | `components/workflows/step-editor.tsx` → `StepEditor` |
| Variable / function | `camelCase` | `resolveWorkflowAccess` |
| Type / interface / enum | `PascalCase`, no `I` prefix | `StepExecutionContext` |
| Constant (module-level, fixed) | `SCREAMING_SNAKE_CASE` | `MAX_STEP_ATTEMPTS` |
| Environment variable | `SCREAMING_SNAKE_CASE` | `LLM_API_KEY` |
| Hook | `use` prefix | `useActiveOrg` |
| Boolean | `is` / `has` / `can` prefix | `canTriggerRun` |
| Async function | name the result, not the asynchrony | `fetchStepRuns`, not `getStepRunsAsync` |

Types that mirror database rows keep the database's field names — a `WorkflowStepRow` has
`step_order`. Types that model application concepts use `camelCase`. Convert at the edge (the
GraphQL client boundary), in one place, and only when the application concept genuinely differs
from the row.

Prefer `type` for object shapes and unions; reach for `interface` only when declaration merging
or `implements` is actually needed. Derive union types from a single source rather than
restating them:

```ts
export const STEP_TYPES = [
  'llm_call',
  'http_request',
  'db_write',
  'notify',
  'conditional_branch',
  'approval_gate',
] as const;

export type StepType = (typeof STEP_TYPES)[number];
export const PRIVILEGED_STEP_TYPES = ['db_write', 'notify'] satisfies readonly StepType[];
```

`satisfies` over `as` — it checks the value against the type instead of asserting past it.

Never use `any`. When a shape is genuinely unknown (a `config` JSONB blob, an external API
body), type it `unknown` and validate with Zod at the boundary. The validated output is where
type safety starts; everything upstream of it is a claim, not a fact.

## Folder layout

```
.
├── nhost/
│   ├── nhost.toml
│   ├── migrations/default/          committed, ordered, never edited after apply
│   └── metadata/                    tables.yaml, actions.yaml, cron_triggers.yaml, ...
├── functions/                       nhost serverless functions (route = file path)
│   ├── actions/
│   ├── events/
│   ├── cron/
│   └── _lib/                        underscore-prefixed: shared code, not routed
└── web/                             Next.js app
    ├── app/
    ├── components/{ui,workflows,runs,org}/
    ├── lib/{nhost,graphql,workflow}/
    ├── hooks/
    └── types/
```

Group by feature inside `components/` and `lib/`, not by technical kind. `components/runs/`
holds everything about viewing runs; a `components/cards/` directory tells a reader nothing
about where to look.

## Comments

Comment the *why*, never the *what*. The code already says what it does, and a comment that
repeats it becomes a lie the first time the code changes.

```ts
// Bad — restates the call
// Increment the org's quota usage
await incrementQuotaUsage(orgId);

// Bad — restates the condition
// If there are no rows, the quota is exhausted
if (affectedRows === 0) throw new QuotaExhaustedError();

// Good — explains a decision the reader cannot infer
// Guarded update rather than read-then-write: concurrent runs would otherwise both
// observe headroom and overshoot the org's allowance.
if (affectedRows === 0) throw new QuotaExhaustedError();
```

Worth a comment: a constraint chosen for a non-obvious reason (`deferrable` uniqueness for
reordering), a workaround for external behavior, a security invariant that isn't visible
locally, a formula's source. Not worth a comment: section banners, restated conditionals,
`// TODO` with no owner or context, JSDoc that repeats the signature.

Names carry the explanatory weight. `PRIVILEGED_STEP_TYPES` needs no comment; `SPECIAL_TYPES`
needs a paragraph.

## Migrations

One migration per logical change, `up.sql` and a real `down.sql`. Applied migrations are
immutable — correct them with a new migration. Every migration must be safe to run against a
database that already has data: add columns nullable or with a default, backfill, then add the
constraint.
