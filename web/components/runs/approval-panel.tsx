'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { GraphQLRequestError, describeError, request } from '@/lib/graphql/client';
import { APPROVE_STEP } from '@/lib/graphql/operations';
import type { OrgRole, StepRun } from '@/lib/types/database';

type Props = {
  stepRun: StepRun;
  role: OrgRole;
};

const DEFAULT_APPROVER_ROLES: OrgRole[] = ['owner', 'editor'];

function allowedRolesFor(stepRun: StepRun): OrgRole[] {
  const configured = stepRun.step?.config.allowed_roles;
  if (Array.isArray(configured) && configured.length > 0) return configured as OrgRole[];
  return DEFAULT_APPROVER_ROLES;
}

export function ApprovalPanel({ stepRun, role }: Props) {
  const [comment, setComment] = useState('');
  const [isApproving, setIsApproving] = useState(false);

  const allowedRoles = allowedRolesFor(stepRun);
  const mayApprove = allowedRoles.includes(role);
  const instructions = stepRun.step?.config.instructions;

  async function approve() {
    setIsApproving(true);
    try {
      await request(APPROVE_STEP, { stepRunId: stepRun.id, comment: comment || null }, role);
      // No optimistic update: the subscription delivers the transition. A UI that says
      // approved while the engine disagrees is worse than half a second of latency.
      toast.success('Approved — the run is resuming');
    } catch (cause) {
      if (cause instanceof GraphQLRequestError && cause.code === 'conflict') {
        // Two people watching the same paused run will both click. That is a normal
        // outcome, not a failure.
        toast.info('Someone else approved this step first');
      } else {
        toast.error(describeError(cause));
      }
    } finally {
      setIsApproving(false);
    }
  }

  return (
    <Alert className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
      <AlertDescription className="space-y-3">
        <div>
          <p className="text-sm font-medium">This run is paused, awaiting approval</p>
          {typeof instructions === 'string' && instructions ? (
            <p className="mt-1 text-sm text-muted-foreground">{instructions}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            Allowed to approve: {allowedRoles.join(', ')}
          </p>
        </div>

        {mayApprove ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="approval-comment" className="text-xs">
                Comment (optional)
              </Label>
              <Input
                id="approval-comment"
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Why you are approving"
              />
            </div>
            <Button onClick={approve} disabled={isApproving}>
              {isApproving ? 'Approving…' : 'Approve and continue'}
            </Button>
          </div>
        ) : (
          <p className="text-xs">
            Your role ({role}) cannot clear this gate. The handler checks your membership in
            this organization, so this is not just a hidden button.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
