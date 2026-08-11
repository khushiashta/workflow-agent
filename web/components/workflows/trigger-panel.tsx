'use client';

import { Copy, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describeError, request } from '@/lib/graphql/client';
import { CREATE_WEBHOOK_TRIGGER } from '@/lib/graphql/operations';
import type { OrgRole, WorkflowTrigger } from '@/lib/types/database';
import { canEditWorkflow, canMintWebhookToken } from '@/lib/workflow/permissions';

type Props = {
  workflowId: string;
  role: OrgRole;
  triggers: WorkflowTrigger[];
  manualEnabled: boolean;
  onManualChange: (enabled: boolean) => void;
  onWebhookMinted: () => void;
};

export function TriggerPanel({
  workflowId,
  role,
  triggers,
  manualEnabled,
  onManualChange,
  onWebhookMinted,
}: Props) {
  const [token, setToken] = useState<string | null>(null);
  const [isMinting, setIsMinting] = useState(false);

  const webhook = triggers.find((trigger) => trigger.trigger_type === 'webhook');
  const canEdit = canEditWorkflow(role);
  const canMint = canMintWebhookToken(role);

  async function mintToken() {
    setIsMinting(true);
    try {
      const result = await request<{ createWebhookTrigger: { token: string } }>(
        CREATE_WEBHOOK_TRIGGER,
        { workflowId },
        role,
      );
      setToken(result.createWebhookTrigger.token);
      onWebhookMinted();
      toast.success(webhook ? 'Token rotated' : 'Webhook trigger created');
    } catch (cause) {
      toast.error(describeError(cause));
    } finally {
      setIsMinting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Triggers</CardTitle>
        <CardDescription>How this workflow can be started</CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Manual</p>
            <p className="text-xs text-muted-foreground">A user clicks Run</p>
          </div>
          <Switch
            checked={manualEnabled}
            disabled={!canEdit}
            onCheckedChange={onManualChange}
            aria-label="Manual trigger enabled"
          />
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-sm font-medium">
                Webhook
                {webhook ? <Badge variant="secondary">active</Badge> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                An external system calls it with a token, no login
              </p>
            </div>

            {canMint ? (
              <Button variant="outline" size="sm" onClick={mintToken} disabled={isMinting}>
                <KeyRound className="mr-1.5 size-3.5" />
                {webhook ? 'Rotate token' : 'Create webhook'}
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" disabled>
                    <KeyRound className="mr-1.5 size-3.5" />
                    Create webhook
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Only an owner can create a webhook trigger — it opens an unauthenticated
                  way into this organization.
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {token ? (
            <Alert>
              <AlertDescription className="space-y-2">
                <p className="text-xs font-medium">
                  Copy this now — only the hash is stored, so it cannot be shown again.
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                    {token}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    onClick={() => {
                      void navigator.clipboard.writeText(token);
                      toast.success('Token copied');
                    }}
                    aria-label="Copy token"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
