import type { StepType } from '@/lib/types/database';

export type FieldSpec = {
  key: string;
  label: string;
  kind: 'text' | 'textarea' | 'number' | 'select' | 'json' | 'roles';
  options?: readonly string[];
  placeholder?: string;
  help?: string;
};

export type StepTypeSpec = {
  label: string;
  description: string;
  fields: readonly FieldSpec[];
  defaultConfig: Record<string, unknown>;
};

const TEMPLATE_HELP = 'Supports {{trigger.payload.x}} and {{steps.<order>.output.x}}';

export const BRANCH_OPERATORS = [
  'contains',
  'not_contains',
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'is_truthy',
] as const;

export const STEP_TYPE_SPECS: Record<StepType, StepTypeSpec> = {
  llm_call: {
    label: 'LLM call',
    description: 'Sends a prompt to a real language model and captures the reply',
    fields: [
      { key: 'prompt', label: 'Prompt', kind: 'textarea', help: TEMPLATE_HELP },
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'leave blank for the default' },
      { key: 'temperature', label: 'Temperature', kind: 'number' },
      { key: 'max_tokens', label: 'Max tokens', kind: 'number' },
    ],
    defaultConfig: {
      prompt: 'Reply with exactly one word, URGENT or NORMAL. Message: {{trigger.payload.text}}',
      temperature: 0,
      max_tokens: 8,
    },
  },
  http_request: {
    label: 'HTTP request',
    description: 'Calls an external API. Internal and link-local addresses are refused',
    fields: [
      { key: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { key: 'url', label: 'URL', kind: 'text', placeholder: 'https://api.example.com/status' },
      { key: 'body', label: 'Body', kind: 'json', help: 'JSON, ignored for GET' },
      { key: 'timeout_ms', label: 'Timeout (ms)', kind: 'number' },
    ],
    defaultConfig: { method: 'GET', url: 'https://api.github.com/zen', timeout_ms: 10000 },
  },
  conditional_branch: {
    label: 'Conditional branch',
    description: "Chooses the next step from the previous step's output",
    fields: [
      { key: 'left', label: 'Left operand', kind: 'text', help: TEMPLATE_HELP },
      { key: 'operator', label: 'Operator', kind: 'select', options: BRANCH_OPERATORS },
      { key: 'right', label: 'Right operand', kind: 'text' },
      { key: 'then_step_order', label: 'If true, go to step', kind: 'number' },
      { key: 'else_step_order', label: 'Otherwise go to step', kind: 'number' },
    ],
    defaultConfig: {
      left: '{{steps.1.output.text}}',
      operator: 'contains',
      right: 'URGENT',
      then_step_order: 3,
      else_step_order: 5,
    },
  },
  approval_gate: {
    label: 'Approval gate',
    description: 'Pauses the run until someone with the right role approves',
    fields: [
      { key: 'instructions', label: 'Instructions for the approver', kind: 'textarea' },
      { key: 'allowed_roles', label: 'Who may approve', kind: 'roles' },
    ],
    defaultConfig: {
      instructions: 'Confirm this should be escalated',
      allowed_roles: ['owner', 'editor'],
    },
  },
  db_write: {
    label: 'Database write',
    description: 'Saves a result into your own tables',
    fields: [
      { key: 'label', label: 'Label', kind: 'text', placeholder: 'triage_verdict' },
      { key: 'payload', label: 'Payload', kind: 'json', help: TEMPLATE_HELP },
    ],
    defaultConfig: { label: 'result', payload: { verdict: '{{steps.1.output.text}}' } },
  },
  notify: {
    label: 'Notify',
    description: 'Queues a Slack or email alert, delivered outside the run',
    fields: [
      { key: 'channel', label: 'Channel', kind: 'select', options: ['slack', 'email'] },
      { key: 'recipient', label: 'Recipient', kind: 'text', placeholder: '#alerts' },
      { key: 'subject', label: 'Subject', kind: 'text' },
      { key: 'body', label: 'Body', kind: 'textarea', help: TEMPLATE_HELP },
    ],
    defaultConfig: {
      channel: 'slack',
      recipient: '#alerts',
      subject: 'Workflow finished',
      body: 'Verdict: {{steps.1.output.text}}',
    },
  },
};
