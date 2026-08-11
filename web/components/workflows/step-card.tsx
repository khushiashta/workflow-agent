'use client';

import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { StepType, WorkflowStep } from '@/lib/types/database';
import { PRIVILEGED_STEP_TYPES } from '@/lib/types/database';
import { STEP_TYPE_SPECS } from '@/lib/workflow/step-types';
import { StepConfigFields } from './step-config-fields';

type Props = {
  step: WorkflowStep;
  index: number;
  total: number;
  disabled: boolean;
  onChange: (step: WorkflowStep) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
};

export function StepCard({ step, index, total, disabled, onChange, onMove, onRemove }: Props) {
  const spec = STEP_TYPE_SPECS[step.step_type];
  const isPrivileged = PRIVILEGED_STEP_TYPES.includes(step.step_type);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3 pb-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
          {step.step_order}
        </span>

        <Input
          value={step.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...step, name: event.target.value })}
          className="h-8 w-52 text-sm"
          placeholder="Step name"
        />

        <Badge variant={isPrivileged ? 'default' : 'secondary'} className="font-normal">
          {spec.label}
        </Badge>

        {isPrivileged ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="cursor-default font-normal">
                owner-only
              </Badge>
            </TooltipTrigger>
            <TooltipContent>
              Only an owner can author this step type. Enforced by a Hasura insert and
              update check, not by this label.
            </TooltipContent>
          </Tooltip>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={disabled || index === 0}
            onClick={() => onMove(-1)}
            aria-label="Move step up"
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={disabled || index === total - 1}
            onClick={() => onMove(1)}
            aria-label="Move step down"
          >
            <ChevronDown className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive"
            disabled={disabled}
            onClick={onRemove}
            aria-label="Remove step"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{spec.description}</p>
        <StepConfigFields
          stepId={step.id}
          stepType={step.step_type as StepType}
          config={step.config}
          disabled={disabled}
          onChange={(config) => onChange({ ...step, config })}
        />
      </CardContent>
    </Card>
  );
}
