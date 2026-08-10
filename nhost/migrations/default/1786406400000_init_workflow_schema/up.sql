create extension if not exists pgcrypto;

create or replace function public.set_current_timestamp_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


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

create trigger set_updated_at before update on public.organizations
for each row execute function public.set_current_timestamp_updated_at();


create table public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_member_role_supported check (role in ('owner', 'editor', 'viewer')),
  constraint org_member_unique_per_org unique (org_id, user_id)
);

create index org_members_user_id_idx on public.org_members (user_id);

create trigger set_updated_at before update on public.org_members
for each row execute function public.set_current_timestamp_updated_at();


create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for the composite foreign key on workflow_runs, which is what keeps the
  -- denormalized org_id on a run from ever disagreeing with its workflow's org.
  constraint workflows_id_org_id_key unique (id, org_id)
);

create index workflows_org_id_idx on public.workflows (org_id);

create trigger set_updated_at before update on public.workflows
for each row execute function public.set_current_timestamp_updated_at();


create table public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  step_order integer not null,
  step_type text not null,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint step_order_positive check (step_order > 0),
  constraint step_type_supported check (
    step_type in (
      'llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate'
    )
  ),
  -- Deferred so reordering can swap step_order values inside one transaction; a
  -- per-statement check would reject the transient collision.
  constraint workflow_steps_order_unique unique (workflow_id, step_order)
    deferrable initially deferred
);

create index workflow_steps_workflow_id_step_order_idx
  on public.workflow_steps (workflow_id, step_order);

create trigger set_updated_at before update on public.workflow_steps
for each row execute function public.set_current_timestamp_updated_at();


create table public.workflow_triggers (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  trigger_type text not null,
  is_enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  -- SHA-256 of the inbound webhook token. The plaintext is shown once at creation and
  -- never stored, so reading this row is not the same as holding the credential.
  webhook_secret_hash text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trigger_type_supported check (
    trigger_type in ('manual', 'webhook', 'scheduled', 'database_event')
  )
);

create index workflow_triggers_workflow_id_idx on public.workflow_triggers (workflow_id);
create index workflow_triggers_type_enabled_idx
  on public.workflow_triggers (trigger_type, is_enabled);

create trigger set_updated_at before update on public.workflow_triggers
for each row execute function public.set_current_timestamp_updated_at();


create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  org_id uuid not null,
  status text not null default 'queued',
  trigger_type text not null,
  triggered_by uuid references auth.users (id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  error text,
  resume_from_step_order integer,
  started_at timestamptz,
  finished_at timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint run_status_supported check (
    status in ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')
  ),
  constraint run_trigger_type_supported check (
    trigger_type in ('manual', 'webhook', 'scheduled', 'database_event')
  ),
  constraint workflow_runs_workflow_org_fkey foreign key (workflow_id, org_id)
    references public.workflows (id, org_id) on delete cascade,
  -- Redundant against the composite key above, but Hasura infers object and array
  -- relationships from single-column foreign keys; without these the run's `workflow`
  -- and `organization` relationships have to be wired by hand.
  constraint workflow_runs_workflow_id_fkey foreign key (workflow_id)
    references public.workflows (id) on delete cascade,
  constraint workflow_runs_org_id_fkey foreign key (org_id)
    references public.organizations (id) on delete cascade
);

create index workflow_runs_workflow_id_created_at_idx
  on public.workflow_runs (workflow_id, created_at desc);
create index workflow_runs_org_id_created_at_idx
  on public.workflow_runs (org_id, created_at desc);
-- Supports the stalled-run sweep: a serverless invocation that dies mid-run leaves the
-- row 'running' with a heartbeat that stops advancing.
create index workflow_runs_stalled_idx
  on public.workflow_runs (heartbeat_at) where status = 'running';

create trigger set_updated_at before update on public.workflow_runs
for each row execute function public.set_current_timestamp_updated_at();


create table public.step_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs (id) on delete cascade,
  workflow_step_id uuid not null references public.workflow_steps (id) on delete cascade,
  step_order integer not null,
  status text not null default 'pending',
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
  constraint step_status_supported check (
    status in ('pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'skipped')
  ),
  constraint attempt_count_non_negative check (attempt_count >= 0),
  -- Makes step claiming idempotent: a redelivered trigger upserts onto this key instead
  -- of producing a second step_run for the same step.
  constraint step_runs_unique_per_run unique (workflow_run_id, workflow_step_id)
);

create index step_runs_workflow_run_id_step_order_idx
  on public.step_runs (workflow_run_id, step_order);

create trigger set_updated_at before update on public.step_runs
for each row execute function public.set_current_timestamp_updated_at();


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
  constraint notification_status_supported check (status in ('queued', 'sent', 'failed'))
);

create index notifications_org_id_idx on public.notifications (org_id);

create trigger set_updated_at before update on public.notifications
for each row execute function public.set_current_timestamp_updated_at();


-- Guarded increment. Returning zero rows means the allowance was already spent; a
-- read-then-write would let concurrent runs both observe headroom and overshoot it.
create or replace function public.consume_org_quota(target_org_id uuid)
returns setof public.organizations as $$
  update public.organizations
     set quota_calls_used = quota_calls_used + 1,
         updated_at = now()
   where id = target_org_id
     and quota_calls_used < quota_calls_allowed
  returning *;
$$ language sql volatile;


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
      where r.finished_at is not null
        and r.started_at is not null
        and r.created_at >= o.quota_period_started_at
    )::numeric,
    2
  ) as avg_run_seconds_this_period
from public.organizations o
left join public.workflow_runs r on r.org_id = o.id
group by o.id;
