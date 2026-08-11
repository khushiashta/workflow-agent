'use client';

import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { OrgRole, StepType } from '@/lib/types/database';
import type { FieldSpec } from '@/lib/workflow/step-types';
import { STEP_TYPE_SPECS } from '@/lib/workflow/step-types';

const APPROVER_ROLES: OrgRole[] = ['owner', 'editor'];

type Props = {
  stepId: string;
  stepType: StepType;
  config: Record<string, unknown>;
  disabled: boolean;
  onChange: (config: Record<string, unknown>) => void;
};

/**
 * Rendered from the per-type field specs rather than a component per step type, so adding
 * a step type is a data change. The JSON fields are the escape hatch for the two configs
 * that are genuinely free-form.
 */
export function StepConfigFields({ stepId, stepType, config, disabled, onChange }: Props) {
  const spec = STEP_TYPE_SPECS[stepType];

  const setValue = (key: string, value: unknown) => {
    const next = { ...config };
    if (value === '' || value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {spec.fields.map((field) => (
        <div
          key={field.key}
          className={field.kind === 'textarea' || field.kind === 'json' ? 'sm:col-span-2' : ''}
        >
          <Field
            field={field}
            id={`${stepId}-${field.key}`}
            value={config[field.key]}
            disabled={disabled}
            onChange={(value) => setValue(field.key, value)}
          />
        </div>
      ))}
    </div>
  );
}

type FieldProps = {
  field: FieldSpec;
  id: string;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
};

function Field({ field, id, value, disabled, onChange }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {field.label}
      </Label>

      {field.kind === 'textarea' ? (
        <Textarea
          id={id}
          rows={3}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs"
        />
      ) : null}

      {field.kind === 'text' ? (
        <Input
          id={id}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono text-xs"
        />
      ) : null}

      {field.kind === 'number' ? (
        <Input
          id={id}
          type="number"
          disabled={disabled}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
          className="font-mono text-xs"
        />
      ) : null}

      {field.kind === 'select' ? (
        <Select
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onValueChange={onChange}
        >
          <SelectTrigger id={id} className="text-xs">
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {field.options?.map((option) => (
              <SelectItem key={option} value={option} className="text-xs">
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {field.kind === 'json' ? (
        <JsonField id={id} value={value} disabled={disabled} onChange={onChange} />
      ) : null}

      {field.kind === 'roles' ? (
        <div className="flex gap-4 pt-1">
          {APPROVER_ROLES.map((role) => {
            const selected = Array.isArray(value) ? (value as string[]) : ['owner', 'editor'];
            return (
              <label key={role} className="flex items-center gap-2 text-xs">
                <Checkbox
                  disabled={disabled}
                  checked={selected.includes(role)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...new Set([...selected, role])]
                      : selected.filter((entry) => entry !== role);
                    // An empty list would make the gate unclearable by anyone.
                    onChange(next.length > 0 ? next : [role]);
                  }}
                />
                {role}
              </label>
            );
          })}
        </div>
      ) : null}

      {field.help ? <p className="text-[11px] text-muted-foreground">{field.help}</p> : null}
    </div>
  );
}

/**
 * Keeps the raw text while it is being edited so a half-typed object is not thrown away
 * on every keystroke, and only lifts the value once it parses.
 */
function JsonField({ id, value, disabled, onChange }: Omit<FieldProps, 'field'>) {
  const [draft, setDraft] = useState<string | null>(null);
  const serialized = value === undefined ? '' : JSON.stringify(value, null, 2);
  const text = draft ?? serialized;

  let parseError: string | null = null;
  if (draft !== null && draft.trim() !== '') {
    try {
      JSON.parse(draft);
    } catch {
      parseError = 'Not valid JSON yet';
    }
  }

  return (
    <div className="space-y-1">
      <Textarea
        id={id}
        rows={4}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === '') {
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(next));
          } catch {
            // Held in the draft until it parses.
          }
        }}
        onBlur={() => setDraft(null)}
        className="font-mono text-xs"
      />
      {parseError ? <p className="text-[11px] text-amber-600">{parseError}</p> : null}
    </div>
  );
}
