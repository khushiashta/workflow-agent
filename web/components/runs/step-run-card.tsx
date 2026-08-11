'use client';

import { AlertTriangle, Check, Loader2, Minus, PauseCircle } from 'lucide-react';
import { StepStatusBadge } from '@/components/runs/run-status-badge';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { StepRun, StepRunStatus } from '@/lib/types/database';
import { STEP_TYPE_SPECS } from '@/lib/workflow/step-types';

const ICONS: Record<StepRunStatus, React.ReactNode> = {
  pending: <Minus className="size-4 text-muted-foreground" />,
  running: <Loader2 className="size-4 animate-spin text-blue-600" />,
  awaiting_approval: <PauseCircle className="size-4 text-amber-600" />,
  succeeded: <Check className="size-4 text-emerald-600" />,
  failed: <AlertTriangle className="size-4 text-destructive" />,
  skipped: <Minus className="size-4 text-muted-foreground" />,
};

function durationOf(stepRun: StepRun): string | null {
  if (!stepRun.started_at || !stepRun.finished_at) return null;
  const ms = new Date(stepRun.finished_at).getTime() - new Date(stepRun.started_at).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function StepRunCard({ stepRun }: { stepRun: StepRun }) {
  const stepType = stepRun.step?.step_type;
  const spec = stepType ? STEP_TYPE_SPECS[stepType] : null;
  const duration = durationOf(stepRun);

  const branch = stepRun.output as
    | { matched?: boolean; evaluated_left?: unknown; next_step_order?: number | null }
    | null;
  const isBranch = stepType === 'conditional_branch' && branch !== null;
  const isStubbedLlm = stepType === 'llm_call' && stepRun.output?.stubbed === true;

  return (
    <Card className={stepRun.status === 'skipped' ? 'opacity-60' : undefined}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 pb-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {stepRun.step_order}
        </span>
        {ICONS[stepRun.status]}

        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{stepRun.step?.name ?? 'Step'}</p>
          <p className="text-xs text-muted-foreground">{spec?.label ?? stepType}</p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* A step that needed two tries is worth seeing, not just recording. */}
          {stepRun.attempt_count > 1 ? (
            <Badge variant="outline" className="font-normal text-amber-700 dark:text-amber-500">
              retry {stepRun.attempt_count} of 2
            </Badge>
          ) : null}
          {isStubbedLlm ? (
            <Badge variant="outline" className="font-normal">
              stubbed
            </Badge>
          ) : null}
          {duration ? <span className="font-mono text-xs text-muted-foreground">{duration}</span> : null}
          <StepStatusBadge status={stepRun.status} />
        </div>
      </CardHeader>

      {stepRun.status !== 'pending' ? (
        <CardContent className="space-y-2 pt-0">
          {/* The branch persisted the operand it actually resolved, so "why did it take
              the else path?" is answerable from the record rather than by re-running. */}
          {isBranch ? (
            <p className="text-xs">
              <span className="text-muted-foreground">evaluated </span>
              <code className="rounded bg-muted px-1 py-0.5 font-mono">
                {JSON.stringify(branch?.evaluated_left)}
              </code>
              <span className="text-muted-foreground">
                {' '}
                → {branch?.matched ? 'true' : 'false'}, continuing at step{' '}
                {branch?.next_step_order ?? 'end'}
              </span>
            </p>
          ) : null}

          {stepRun.approved_at ? (
            <p className="text-xs text-muted-foreground">
              approved by {stepRun.approver?.displayName ?? 'someone'}
              {stepRun.approval_comment ? ` — “${stepRun.approval_comment}”` : ''}
            </p>
          ) : null}

          {/* Errors are visible without a click; that is the whole point of them. */}
          {stepRun.error ? (
            <p className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
              {stepRun.error}
            </p>
          ) : null}

          {stepRun.output && !isBranch ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Output</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px]">
                {JSON.stringify(stepRun.output, null, 2)}
              </pre>
            </details>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
