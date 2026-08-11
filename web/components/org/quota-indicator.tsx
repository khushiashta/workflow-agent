'use client';

import { useActiveMembership } from '@/app/providers';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useQuery } from '@/hooks/use-query';
import { ORG_USAGE } from '@/lib/graphql/operations';
import type { UsageSummary } from '@/lib/types/database';

export function useOrgUsage() {
  const membership = useActiveMembership();
  return useQuery<{ org_usage_summary: UsageSummary[] }>(
    membership ? ORG_USAGE : null,
    { orgId: membership?.org_id },
    membership?.role,
  );
}

export function QuotaIndicator() {
  const { data, isLoading } = useOrgUsage();
  const usage = data?.org_usage_summary.at(0);

  if (isLoading && !usage) return <Skeleton className="h-9 w-40" />;
  if (!usage) return null;

  const percentUsed = Math.min(
    100,
    Math.round((usage.quota_calls_used / usage.quota_calls_allowed) * 100),
  );

  // Colour is the earliest signal that a run is about to be refused, which otherwise only
  // surfaces as an error after composing one.
  const tone =
    usage.quota_calls_remaining === 0
      ? 'text-destructive'
      : percentUsed >= 80
        ? 'text-amber-600 dark:text-amber-500'
        : 'text-muted-foreground';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="w-40 space-y-1">
          <div className={`flex items-baseline justify-between text-xs ${tone}`}>
            <span>Quota</span>
            <span className="font-mono">
              {usage.quota_calls_used}/{usage.quota_calls_allowed}
            </span>
          </div>
          <Progress value={percentUsed} className="h-1.5" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="space-y-1">
        <p>{usage.quota_calls_remaining} calls remaining this period</p>
        <p className="text-xs opacity-80">
          {usage.runs_this_period} runs, {usage.failed_runs_this_period} failed
          {usage.avg_run_seconds_this_period !== null
            ? `, ${usage.avg_run_seconds_this_period}s average`
            : ''}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
