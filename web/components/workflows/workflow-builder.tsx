'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useActiveMembership } from '@/app/providers';
import { useOrgUsage } from '@/components/org/quota-indicator';
import { RunStatusBadge } from '@/components/runs/run-status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useQuery } from '@/hooks/use-query';
import { describeError, request } from '@/lib/graphql/client';
import {
  SAVE_WORKFLOW_STEPS,
  SAVE_WORKFLOW_TRIGGERS,
  UPDATE_WORKFLOW,
  WORKFLOW_DETAIL,
} from '@/lib/graphql/operations';
import type { StepType, Workflow, WorkflowStep } from '@/lib/types/database';
import { STEP_TYPES } from '@/lib/types/database';
import { canEditWorkflow, whyStepTypeDisabled } from '@/lib/workflow/permissions';
import { STEP_TYPE_SPECS } from '@/lib/workflow/step-types';
import { RunButton } from './run-button';
import { StepCard } from './step-card';
import { TriggerPanel } from './trigger-panel';

export function WorkflowBuilder({ workflowId }: { workflowId: string }) {
  const membership = useActiveMembership();
  const usage = useOrgUsage();

  const { data, error, isLoading, refetch } = useQuery<{ workflows_by_pk: Workflow | null }>(
    membership ? WORKFLOW_DETAIL : null,
    { workflowId },
    membership?.role,
  );

  const workflow = data?.workflows_by_pk ?? null;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [manualEnabled, setManualEnabled] = useState(true);
  const [addType, setAddType] = useState<StepType>('llm_call');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!workflow) return;
    setName(workflow.name);
    setDescription(workflow.description ?? '');
    setSteps(workflow.steps);
    setManualEnabled(
      workflow.triggers.some(
        (trigger) => trigger.trigger_type === 'manual' && trigger.is_enabled,
      ),
    );
  }, [workflow]);

  const role = membership?.role;
  const canEdit = role ? canEditWorkflow(role) : false;
  const quotaRemaining = usage.data?.org_usage_summary.at(0)?.quota_calls_remaining ?? null;

  const isDirty = useMemo(() => {
    if (!workflow) return false;
    return (
      name !== workflow.name ||
      description !== (workflow.description ?? '') ||
      JSON.stringify(steps) !== JSON.stringify(workflow.steps) ||
      manualEnabled !==
        workflow.triggers.some(
          (trigger) => trigger.trigger_type === 'manual' && trigger.is_enabled,
        )
    );
  }, [workflow, name, description, steps, manualEnabled]);

  function addStep() {
    const spec = STEP_TYPE_SPECS[addType];
    setSteps((current) => [
      ...current,
      {
        // Client-generated so saving is one idempotent upsert rather than a diff of
        // inserts and updates.
        id: crypto.randomUUID(),
        step_order: current.length + 1,
        step_type: addType,
        name: spec.label,
        config: structuredClone(spec.defaultConfig),
      },
    ]);
  }

  function moveStep(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const next = [...current];
      const target = index + direction;
      const moved = next[index];
      const displaced = next[target];
      if (!moved || !displaced) return current;
      next[index] = displaced;
      next[target] = moved;
      return next.map((step, position) => ({ ...step, step_order: position + 1 }));
    });
  }

  function removeStep(index: number) {
    setSteps((current) =>
      current
        .filter((_, position) => position !== index)
        .map((step, position) => ({ ...step, step_order: position + 1 })),
    );
  }

  async function save() {
    if (!membership || !workflow) return;
    setIsSaving(true);

    try {
      await request(
        UPDATE_WORKFLOW,
        { id: workflow.id, set: { name, description: description || null } },
        membership.role,
      );

      await request(
        SAVE_WORKFLOW_STEPS,
        {
          workflowId: workflow.id,
          keptIds: steps.map((step) => step.id),
          steps: steps.map((step) => ({
            id: step.id,
            workflow_id: workflow.id,
            step_order: step.step_order,
            step_type: step.step_type,
            name: step.name,
            config: step.config,
          })),
        },
        membership.role,
      );

      const manualTrigger = workflow.triggers.find(
        (trigger) => trigger.trigger_type === 'manual',
      );
      await request(
        SAVE_WORKFLOW_TRIGGERS,
        {
          workflowId: workflow.id,
          keptIds: manualEnabled && manualTrigger ? [manualTrigger.id] : [],
          triggers: manualEnabled
            ? [
                {
                  id: manualTrigger?.id ?? crypto.randomUUID(),
                  workflow_id: workflow.id,
                  trigger_type: 'manual',
                  is_enabled: true,
                  config: {},
                },
              ]
            : [],
        },
        membership.role,
      );

      toast.success('Workflow saved');
      refetch();
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading && !workflow) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!workflow || !role) {
    return (
      <Card>
        <CardContent className="space-y-2 py-10 text-center">
          <p className="text-sm font-medium">This workflow is not available</p>
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{workflow.name}</h1>
          <p className="text-sm text-muted-foreground">
            {steps.length} step{steps.length === 1 ? '' : 's'} · you are {role}
            {canEdit ? '' : ' · read only'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isDirty ? (
            <Button variant="outline" onClick={save} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          ) : null}
          <RunButton workflowId={workflow.id} role={role} quotaRemaining={quotaRemaining} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="workflow-name"
                  value={name}
                  disabled={!canEdit}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-description" className="text-xs">
                  Description
                </Label>
                <Textarea
                  id="workflow-description"
                  rows={2}
                  value={description}
                  disabled={!canEdit}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {steps.map((step, index) => (
            <StepCard
              key={step.id}
              step={step}
              index={index}
              total={steps.length}
              disabled={!canEdit}
              onChange={(next) =>
                setSteps((current) =>
                  current.map((entry, position) => (position === index ? next : entry)),
                )
              }
              onMove={(direction) => moveStep(index, direction)}
              onRemove={() => removeStep(index)}
            />
          ))}

          {canEdit ? (
            <Card>
              <CardContent className="flex flex-wrap items-end gap-3 py-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Add a step</Label>
                  <Select value={addType} onValueChange={(value) => setAddType(value as StepType)}>
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STEP_TYPES.map((stepType) => {
                        const reason = whyStepTypeDisabled(role, stepType);
                        return (
                          <SelectItem key={stepType} value={stepType} disabled={reason !== null}>
                            {STEP_TYPE_SPECS[stepType].label}
                            {reason ? ' — owner only' : ''}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <Button variant="secondary" onClick={addStep}>
                  Add
                </Button>
                <p className="text-xs text-muted-foreground">
                  {whyStepTypeDisabled(role, addType) ?? STEP_TYPE_SPECS[addType].description}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <TriggerPanel
            workflowId={workflow.id}
            role={role}
            triggers={workflow.triggers}
            manualEnabled={manualEnabled}
            onManualChange={setManualEnabled}
            onWebhookMinted={refetch}
          />

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Recent runs</CardTitle>
              <CardDescription>Viewers can watch runs but not start them</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {workflow.runs.length === 0 ? (
                <p className="text-xs text-muted-foreground">No runs yet</p>
              ) : null}
              {workflow.runs.map((run) => (
                <Link
                  key={run.id}
                  href={`/runs/${run.id}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted"
                >
                  <span className="text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()} · {run.trigger_type}
                  </span>
                  <RunStatusBadge status={run.status} />
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
