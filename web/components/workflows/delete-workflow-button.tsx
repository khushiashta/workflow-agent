'use client';

import { Trash2 } from 'lucide-react';
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
import { describeError, request } from '@/lib/graphql/client';
import { DELETE_WORKFLOW } from '@/lib/graphql/operations';
import type { OrgRole } from '@/lib/types/database';
import { canDeleteWorkflow } from '@/lib/workflow/permissions';

type Props = {
  workflowId: string;
  workflowName: string;
  runCount: number;
  role: OrgRole;
};

export function DeleteWorkflowButton({ workflowId, workflowName, runCount, role }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Editors can build workflows but not remove them; the Hasura delete permission is
  // owner-only, so showing this to an editor would only produce a refusal.
  if (!canDeleteWorkflow(role)) return null;

  async function remove() {
    setIsDeleting(true);
    try {
      await request(DELETE_WORKFLOW, { id: workflowId }, role);
      toast.success(`Deleted “${workflowName}”`);
      router.push('/workflows');
    } catch (cause) {
      toast.error(describeError(cause));
      setIsDeleting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="text-destructive" aria-label="Delete workflow">
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{workflowName}”?</DialogTitle>
          <DialogDescription>
            {/* The cascade is worth stating plainly: the run history is the record of what
                this workflow did, and it goes with it. */}
            Its steps, triggers and {runCount === 1 ? '1 run' : `${runCount} runs`} are deleted
            too. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={remove} disabled={isDeleting}>
            {isDeleting ? 'Deleting…' : 'Delete workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
