'use client';

import { Radio } from 'lucide-react';
import Link from 'next/link';
import { useActiveMembership } from '@/app/providers';
import { ApprovalPanel } from '@/components/runs/approval-panel';
import { RunStatusBadge } from '@/components/runs/run-status-badge';
import { StepRunCard } from '@/components/runs/step-run-card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@/hooks/use-query';
import { useSubscription } from '@/hooks/use-subscription';
import { RUN_DETAIL, WATCH_RUN, WATCH_STEP_RUNS } from '@/lib/graphql/operations';
import type { RunStatus, StepRun, WorkflowRun } from '@/lib/types/database';

export function RunTimeline({ runId }: { runId: string }) {
  const membership = useActiveMembership();
  const role = membership?.role;

  // One-shot for the parts that never change, so the page has a heading immediately.
  const detail = useQuery<{ workflow_runs_by_pk: WorkflowRun | null }>(
    role ? RUN_DETAIL : null,
    { runId },
    role,
  );

  // Two narrow subscriptions rather than one nested one: Hasura re-pushes a whole result
  // set on any change, so nesting steps under the run would re-send the run on every step
  // transition.
  const runLive = useSubscription<{
    workflow_runs_by_pk: { status: RunStatus; error: string | null } | null;
  }>(role ? WATCH_RUN : null, { runId }, role);

  const stepsLive = useSubscription<{ step_runs: StepRun[] }>(
    role ? WATCH_STEP_RUNS : null,
    { runId },
    role,
  );

  const run = detail.data?.workflow_runs_by_pk ?? null;
  const status = runLive.data?.workflow_runs_by_pk?.status ?? null;
  const runError = runLive.data?.workflow_runs_by_pk?.error ?? null;
  const stepRuns = stepsLive.data?.step_runs ?? [];

  const awaitingApproval = stepRuns.find((stepRun) => stepRun.status === 'awaiting_approval');

  if (detail.isLoading && !run) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (!run || !role) {
    return (
      <Card>
        <CardContent className="space-y-2 py-10 text-center">
          <p className="text-sm font-medium">This run is not available</p>
          <p className="text-sm text-muted-foreground">
            It does not exist, or it belongs to an organization you are not a member of.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <Link href="/workflows">Back to workflows</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {run.workflow ? (
              <Link href={`/workflows/${run.workflow.id}`} className="hover:underline">
                {run.workflow.name}
              </Link>
            ) : (
              'Run'
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            started via {run.trigger_type} · {new Date(run.created_at).toLocaleString()}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Shown so a stalled page is distinguishable from a stalled run. */}
          <span
            className={`flex items-center gap-1.5 text-xs ${
              stepsLive.isConnected ? 'text-emerald-600' : 'text-muted-foreground'
            }`}
          >
            <Radio className="size-3.5" />
            {stepsLive.isConnected ? 'live' : 'connecting…'}
          </span>
          <RunStatusBadge status={status ?? run.status} />
        </div>
      </div>

      {stepsLive.error ? (
        <Alert variant="destructive">
          <AlertDescription>{stepsLive.error}</AlertDescription>
        </Alert>
      ) : null}

      {runError ? (
        <Alert variant="destructive">
          <AlertDescription className="font-mono text-xs">{runError}</AlertDescription>
        </Alert>
      ) : null}

      {awaitingApproval ? <ApprovalPanel stepRun={awaitingApproval} role={role} /> : null}

      <div className="space-y-3">
        {stepRuns.length === 0 ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          stepRuns.map((stepRun) => <StepRunCard key={stepRun.id} stepRun={stepRun} />)
        )}
      </div>
    </div>
  );
}
