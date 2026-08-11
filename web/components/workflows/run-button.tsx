'use client';

import { Play } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describeError, request } from '@/lib/graphql/client';
import { TRIGGER_WORKFLOW_RUN } from '@/lib/graphql/operations';
import type { OrgRole } from '@/lib/types/database';
import { canTriggerRun } from '@/lib/workflow/permissions';

type Props = {
  workflowId: string;
  role: OrgRole;
  quotaRemaining: number | null;
};

const DEFAULT_PAYLOAD = '{\n  "text": "the checkout page is completely broken and we are losing orders"\n}';

export function RunButton({ workflowId, role, quotaRemaining }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
  const [isRunning, setIsRunning] = useState(false);

  // A viewer gets no button at all. This is presentation: the Action is not exposed to
  // the viewer role, and a viewer claiming another role is refused by the handler.
  if (!canTriggerRun(role)) return null;

  const outOfQuota = quotaRemaining === 0;

  async function startRun() {
    let payload: unknown = {};
    if (payloadText.trim()) {
      try {
        payload = JSON.parse(payloadText);
      } catch {
        toast.error('Payload is not valid JSON');
        return;
      }
    }

    setIsRunning(true);
    try {
      const result = await request<{ triggerWorkflowRun: { workflow_run_id: string } }>(
        TRIGGER_WORKFLOW_RUN,
        { workflowId, payload },
        role,
      );
      setOpen(false);
      router.push(`/runs/${result.triggerWorkflowRun.workflow_run_id}`);
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setIsRunning(false);
    }
  }

  const trigger = (
    <Button disabled={outOfQuota}>
      <Play className="mr-1.5 size-3.5" />
      Run
    </Button>
  );

  if (outOfQuota) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{trigger}</span>
        </TooltipTrigger>
        <TooltipContent>
          This organization has used its whole allowance for the period, so a run would be
          refused.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Start a run</DialogTitle>
          <DialogDescription>
            This payload becomes the run&apos;s trigger context, reachable from step configs
            as <code className="font-mono text-xs">{'{{trigger.payload.text}}'}</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="run-payload" className="text-xs">
            Payload (JSON)
          </Label>
          <Textarea
            id="run-payload"
            rows={6}
            value={payloadText}
            onChange={(event) => setPayloadText(event.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={startRun} disabled={isRunning}>
            {isRunning ? 'Starting…' : 'Run workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
