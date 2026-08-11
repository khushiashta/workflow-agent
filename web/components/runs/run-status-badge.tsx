import { Badge } from '@/components/ui/badge';
import type { RunStatus, StepRunStatus } from '@/lib/types/database';

const RUN_TONES: Record<RunStatus, string> = {
  queued: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  paused: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  succeeded: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  cancelled: 'bg-muted text-muted-foreground',
};

const STEP_TONES: Record<StepRunStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  awaiting_approval: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  succeeded: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  skipped: 'bg-muted text-muted-foreground line-through',
};

const STEP_LABELS: Record<StepRunStatus, string> = {
  pending: 'pending',
  running: 'running',
  awaiting_approval: 'awaiting approval',
  succeeded: 'succeeded',
  failed: 'failed',
  skipped: 'not taken',
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="outline" className={`border-transparent font-normal ${RUN_TONES[status]}`}>
      {status}
    </Badge>
  );
}

export function StepStatusBadge({ status }: { status: StepRunStatus }) {
  return (
    <Badge variant="outline" className={`border-transparent font-normal ${STEP_TONES[status]}`}>
      {STEP_LABELS[status]}
    </Badge>
  );
}
