drop view if exists public.org_usage_summary;
drop function if exists public.consume_org_quota(uuid);

drop table if exists public.notifications;
drop table if exists public.step_outputs;
drop table if exists public.step_runs;
drop table if exists public.workflow_runs;
drop table if exists public.workflow_triggers;
drop table if exists public.workflow_steps;
drop table if exists public.workflows;
drop table if exists public.org_members;
drop table if exists public.organizations;

drop function if exists public.set_current_timestamp_updated_at();
