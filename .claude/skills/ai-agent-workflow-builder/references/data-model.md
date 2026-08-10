# Data model

## Shape and reasoning

```
organizations ──< org_members >── auth.users
      │
      ├──< workflows ──< workflow_steps
      │        │       └─< workflow_triggers
      │        └──< workflow_runs ──< step_runs
      │
      ├──< step_outputs          (db_write target)
      ├──< notifications         (notify queue, drained by an Event Trigger)
      └──< incoming_documents    (watched table for the DB event trigger)
```

Three decisions in here are worth understanding before you write the DDL, because they're the
ones a reviewer will ask about.

**`org_id` is denormalized onto `workflow_runs`.** Without it, the select permission on
`step_runs` has to traverse `run → workflow → organization → members`, and so does every quota
query. With it, the traversal is one hop shorter on the hottest path in the app (the live run
subscription). The risk with denormalization is drift, so it's pinned by a composite foreign
key: `workflows` carries `unique (id, org_id)`, and `workflow_runs` references
`(workflow_id, org_id)` against it. A run whose `org_id` disagrees with its workflow's cannot
be inserted at all — not by the handler, not by a migration, not by psql.

**Enum values live in reference tables.** Hasura exposes a tracked table with a text primary
key as a real GraphQL enum when you mark it `is_enum`, so you get schema-level validation and
autocomplete without the migration pain of native Postgres enum types. Adding a step type
becomes an `insert`.

**Step ordering uses a deferrable unique constraint.** Reordering steps means swapping
`step_order` values, which transiently collides. A `deferrable initially deferred` constraint
checks at commit instead of per-statement, so a single transaction can reorder freely and still
be protected against duplicates. The alternative — sparse ordering with float keys — trades a
clean invariant for rebalancing logic nobody wants to own.

## DDL

```sql
create extension if not exists pgcrypto;

create or replace function public.set_current_timestamp_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
```

Attach that trigger to every table with an `updated_at`:

```sql
create trigger set_updated_at before update on public.<table>
for each row execute function public.set_current_timestamp_updated_at();
```

### Reference tables

```sql
create table public.org_member_roles (value text primary key, comment text);
insert into public.org_member_roles (value, comment) values
  ('owner',  'Full control over workflows, steps, triggers, and membership'),
  ('editor', 'Builds workflows and triggers runs; cannot manage members or privileged steps'),
  ('viewer', 'Read-only; cannot trigger a run');

create table public.step_types (value text primary key, comment text);
insert into public.step_types (value, comment) values
  ('llm_call',           'Calls a real LLM API'),
  ('http_request',       'Calls an arbitrary external HTTP API'),
  ('db_write',           'Writes a result into our own tables'),
  ('notify',             'Enqueues a Slack/email alert, delivered by an Event Trigger'),
  ('conditional_branch', 'Chooses the next step from the previous step output'),
  ('approval_gate',      'Pauses the run until an owner or editor approves');

create table public.trigger_types (value text primary key, comment text);
insert into public.trigger_types (value, comment) values
  ('manual', 'A user clicks Run'),
  ('webhook', 'An external system calls the inbound Action'),
  ('scheduled', 'A cron trigger sweeps due schedules'),
  ('database_event', 'A row change in a watched table');

create table public.run_statuses (value text primary key, comment text);
insert into public.run_statuses (value, comment) values
  ('queued', 'Created, not yet claimed'),
  ('running', 'Claimed and executing'),
  ('paused', 'Stopped at an approval gate'),
  ('succeeded', 'All steps completed'),
  ('failed', 'A step failed after exhausting retries'),
  ('cancelled', 'Stopped by a user');

create table public.step_statuses (value text primary key, comment text);
insert into public.step_statuses (value, comment) values
  ('pending', 'Not started'),
  ('running', 'Executing'),
  ('awaiting_approval', 'Blocked on a human decision'),
  ('succeeded', 'Completed'),
  ('failed', 'Exhausted its attempts'),
  ('skipped', 'Bypassed by a conditional branch');
```

`awaiting_approval` exists as a step status distinct from the run's `paused` because the
subscription is on `step_runs` — the UI needs to know *which* step is blocking, not merely that
something is.

### Core tables

```sql
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  quota_calls_allowed integer not null default 100,
  quota_calls_used integer not null default 0,
  quota_period_started_at timestamptz not null default date_trunc('month', now()),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint quota_used_non_negative check (quota_calls_used >= 0),
  constraint quota_allowed_positive check (quota_calls_allowed > 0)
);

create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null references public.org_member_roles (value),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index org_members_user_id_idx on public.org_members (user_id);
```

`unique (org_id, user_id)` means one role per user per org — a user cannot be both owner and
viewer in the same org, which keeps the permission filters unambiguous.

```sql
create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for the composite FK on workflow_runs, which pins the denormalized org_id.
  unique (id, org_id)
);
create index workflows_org_id_idx on public.workflows (org_id);

create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  step_order integer not null,
  step_type text not null references public.step_types (value),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint step_order_positive check (step_order > 0),
  constraint workflow_steps_order_unique unique (workflow_id, step_order)
    deferrable initially deferred
);
create index workflow_steps_workflow_id_idx on public.workflow_steps (workflow_id, step_order);

create table public.workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  trigger_type text not null references public.trigger_types (value),
  is_enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  webhook_secret_hash text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workflow_triggers_workflow_id_idx on public.workflow_triggers (workflow_id);
create index workflow_triggers_type_enabled_idx
  on public.workflow_triggers (trigger_type, is_enabled);
```

`config` by trigger type: `{"cron": "*/15 * * * *"}` for scheduled,
`{"table": "incoming_documents", "operation": "insert"}` for database_event, `{}` for manual.
`webhook_secret_hash` holds a SHA-256 of the inbound token — the plaintext is returned exactly
once, at creation, and the column is excluded from every role's select permission so a leak of
the row is not a leak of the credential.

```sql
create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  org_id uuid not null,
  status text not null references public.run_statuses (value) default 'queued',
  trigger_type text not null references public.trigger_types (value),
  triggered_by uuid references auth.users (id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  error text,
  resume_from_step_order integer,
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workflow_id, org_id)
    references public.workflows (id, org_id) on delete cascade
);
create index workflow_runs_workflow_id_created_at_idx
  on public.workflow_runs (workflow_id, created_at desc);
create index workflow_runs_org_id_created_at_idx
  on public.workflow_runs (org_id, created_at desc);
create index workflow_runs_resumable_idx
  on public.workflow_runs (status, heartbeat_at) where status = 'running';

create table public.step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs (id) on delete cascade,
  workflow_step_id uuid not null references public.workflow_steps (id) on delete cascade,
  step_order integer not null,
  status text not null references public.step_statuses (value) default 'pending',
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer not null default 0,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workflow_run_id, workflow_step_id)
);
create index step_runs_workflow_run_id_step_order_idx
  on public.step_runs (workflow_run_id, step_order);
```

`unique (workflow_run_id, workflow_step_id)` is what makes step claiming idempotent: the engine
upserts the row, then conditionally moves it `pending → running`. A duplicate delivery of the
same trigger cannot produce two step_runs for the same step.

`heartbeat_at` plus the partial index exist for the stuck-run sweeper — a serverless function
that dies mid-run leaves the row `running`, and the cron sweeper resumes anything whose
heartbeat has gone stale.

### Supporting tables

```sql
create table public.step_outputs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  step_run_id uuid not null references public.step_runs (id) on delete cascade,
  label text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index step_outputs_org_id_idx on public.step_outputs (org_id);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  step_run_id uuid references public.step_runs (id) on delete cascade,
  channel text not null,
  recipient text not null,
  subject text,
  body text not null,
  status text not null default 'queued',
  delivery_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_channel_supported check (channel in ('slack', 'email')),
  constraint notification_status_supported
    check (status in ('queued', 'sent', 'failed'))
);

create table public.incoming_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  title text not null,
  body text not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
```

`notifications` carries its own `org_id` rather than reaching through `step_run → run` because
the Event Trigger payload gives the handler the row and nothing else; having the org on the row
keeps the delivery handler from a second lookup.

### Aggregation view

```sql
create or replace view public.org_usage_summary as
select
  o.id as org_id,
  o.quota_calls_allowed,
  o.quota_calls_used,
  greatest(o.quota_calls_allowed - o.quota_calls_used, 0) as quota_calls_remaining,
  o.quota_period_started_at,
  count(r.id) filter (
    where r.created_at >= o.quota_period_started_at
  ) as runs_this_period,
  count(r.id) filter (
    where r.status = 'failed' and r.created_at >= o.quota_period_started_at
  ) as failed_runs_this_period,
  round(
    avg(extract(epoch from (r.finished_at - r.started_at))) filter (
      where r.finished_at is not null and r.created_at >= o.quota_period_started_at
    )::numeric,
    2
  ) as avg_run_seconds_this_period
from public.organizations o
left join public.workflow_runs r on r.org_id = o.id
group by o.id;
```

Track the view in Hasura, add a **manual object relationship** `organization`
(`org_id → organizations.id`), and give it a select permission that traverses that relationship
into `org_members`. A tracked view without a permission is invisible to non-admin roles, and a
tracked view with a permission that doesn't traverse `org_members` is a cross-org leak wearing a
different hat — the aggregate is exactly the kind of endpoint people forget to scope.

## Relationships to configure in Hasura

| Table | Name | Kind | Via |
|---|---|---|---|
| `organizations` | `members` | array | `org_members.org_id` |
| `organizations` | `workflows` | array | `workflows.org_id` |
| `organizations` | `usage_summary` | object (manual) | `org_usage_summary.org_id` |
| `org_members` | `organization` | object | `org_id` |
| `org_members` | `user` | object | `user_id → auth.users.id` |
| `workflows` | `organization` | object | `org_id` |
| `workflows` | `steps` | array | `workflow_steps.workflow_id` |
| `workflows` | `triggers` | array | `workflow_triggers.workflow_id` |
| `workflows` | `runs` | array | `workflow_runs.workflow_id` |
| `workflow_steps` | `workflow` | object | `workflow_id` |
| `workflow_triggers` | `workflow` | object | `workflow_id` |
| `workflow_runs` | `workflow` | object | `workflow_id` |
| `workflow_runs` | `organization` | object | `org_id` |
| `workflow_runs` | `step_runs` | array | `step_runs.workflow_run_id` |
| `step_runs` | `workflow_run` | object | `workflow_run_id` |
| `step_runs` | `step` | object | `workflow_step_id` |
| `step_runs` | `approver` | object | `approved_by → auth.users.id` |

Every one of these matters for permissions, not just for querying: the filters in
`hasura-permissions.md` are written in terms of these relationship names, so a missing or
renamed relationship shows up as a permission that silently fails to compile.

## Step config shapes

`config` is JSONB so step types can evolve without migrations, but validate it with Zod in the
handler before execution — an unvalidated blob is a runtime error deferred to the worst moment.

```jsonc
// llm_call
{ "prompt": "Classify the sentiment of: {{trigger.payload.text}}",
  "model": "llama-3.3-70b-versatile", "temperature": 0.2, "max_tokens": 512,
  "response_format": "text" }

// http_request
{ "method": "GET", "url": "https://api.example.com/status",
  "headers": { "accept": "application/json" }, "body": null, "timeout_ms": 10000 }

// db_write
{ "label": "sentiment_result", "payload": { "verdict": "{{steps.1.output.text}}" } }

// notify
{ "channel": "slack", "recipient": "#alerts",
  "subject": "Run finished", "body": "Verdict: {{steps.1.output.text}}" }

// conditional_branch
{ "left": "{{steps.1.output.text}}", "operator": "contains", "right": "urgent",
  "then_step_order": 3, "else_step_order": 4 }

// approval_gate
{ "instructions": "Confirm the escalation before notifying the customer",
  "allowed_roles": ["owner", "editor"] }
```

`{{...}}` placeholders resolve against the run context — see the template resolver in
`actions-handlers.md`. Keep the syntax deliberately small (`trigger.payload.*` and
`steps.<order>.output.*`); an expression language here is a security surface, not a feature.
