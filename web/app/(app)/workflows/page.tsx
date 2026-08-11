'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useActiveMembership } from '@/app/providers';
import { RunStatusBadge } from '@/components/runs/run-status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@/hooks/use-query';
import { describeError, request } from '@/lib/graphql/client';
import { CREATE_WORKFLOW, ORG_WORKFLOWS_WITH_LATEST_RUN } from '@/lib/graphql/operations';
import type { Workflow } from '@/lib/types/database';
import { STEP_TYPE_SPECS } from '@/lib/workflow/step-types';
import { canEditWorkflow } from '@/lib/workflow/permissions';

export default function WorkflowsPage() {
  const membership = useActiveMembership();
  const router = useRouter();
  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const { data, error, isLoading, refetch } = useQuery<{ workflows: Workflow[] }>(
    membership ? ORG_WORKFLOWS_WITH_LATEST_RUN : null,
    { orgId: membership?.org_id },
    membership?.role,
  );

  const canEdit = membership ? canEditWorkflow(membership.role) : false;

  async function createWorkflow(event: React.FormEvent) {
    event.preventDefault();
    if (!membership || !newName.trim()) return;

    setIsCreating(true);
    try {
      const result = await request<{ insert_workflows_one: { id: string } }>(
        CREATE_WORKFLOW,
        { object: { org_id: membership.org_id, name: newName.trim() } },
        membership.role,
      );
      setNewName('');
      router.push(`/workflows/${result.insert_workflows_one.id}`);
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            {membership
              ? `${membership.organization.name} · you are ${membership.role}`
              : 'Select an organization'}
          </p>
        </div>

        {canEdit ? (
          <form onSubmit={createWorkflow} className="flex gap-2">
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="New workflow name"
              className="w-56"
            />
            <Button type="submit" disabled={isCreating || !newName.trim()}>
              Create
            </Button>
          </form>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>{error}</span>
            <Button size="sm" variant="outline" onClick={refetch}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {isLoading && !data ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : null}

      {data?.workflows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No workflows in this organization yet.
            {canEdit ? ' Create one above.' : ' A viewer cannot create workflows.'}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4">
        {data?.workflows.map((workflow) => {
          const latestRun = workflow.runs.at(0);

          return (
            <Card key={workflow.id}>
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">
                    <Link href={`/workflows/${workflow.id}`} className="hover:underline">
                      {workflow.name}
                    </Link>
                  </CardTitle>
                  <CardDescription>
                    {workflow.description ?? 'No description'}
                  </CardDescription>
                </div>

                <div className="flex items-center gap-2">
                  {latestRun ? (
                    <Link href={`/runs/${latestRun.id}`} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        last run via {latestRun.trigger_type}
                      </span>
                      <RunStatusBadge status={latestRun.status} />
                    </Link>
                  ) : (
                    <span className="text-xs text-muted-foreground">never run</span>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-wrap items-center gap-2">
                {workflow.steps.map((step) => (
                  <Badge key={step.id} variant="secondary" className="font-normal">
                    {step.step_order}. {STEP_TYPE_SPECS[step.step_type]?.label ?? step.step_type}
                  </Badge>
                ))}
                {workflow.steps.length === 0 ? (
                  <span className="text-xs text-muted-foreground">no steps yet</span>
                ) : null}

                <div className="ml-auto flex gap-1">
                  {workflow.triggers.map((trigger) => (
                    <Badge key={trigger.id} variant="outline" className="font-normal">
                      {trigger.trigger_type}
                      {trigger.is_enabled ? '' : ' (off)'}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
