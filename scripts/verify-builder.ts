/**
 * Builder probes: the exact mutations the UI sends, run as real users.
 *
 * The other suites create workflows with the admin secret, which bypasses every
 * permission — so the operations the app actually issues were never exercised, and a
 * mutation naming a column no role may update shipped and failed only in a user's hands.
 * These import the operations from the app itself rather than restating them, so the
 * probe cannot drift from what the UI sends.
 *
 *   npm run verify:builder
 */

import {
  CREATE_WORKFLOW,
  DELETE_WORKFLOW,
  SAVE_WORKFLOW_STEPS,
  SAVE_WORKFLOW_TRIGGERS,
  UPDATE_WORKFLOW,
  WORKFLOW_DETAIL,
} from '../web/lib/graphql/operations.ts';
import {
  PROBE_PREFIX,
  adminRequest,
  createReporter,
  getToken,
  roleRequest,
  sweepProbeFixtures,
} from './_lib/api.ts';

const ORG_A_ID = '11111111-1111-1111-1111-111111111111';

type StepDraft = {
  id: string;
  workflow_id: string;
  step_order: number;
  step_type: string;
  name: string;
  config: Record<string, unknown>;
};

const buildSteps = (workflowId: string, includePrivileged: boolean): StepDraft[] => {
  const steps: Omit<StepDraft, 'id' | 'workflow_id'>[] = [
    {
      step_order: 1,
      step_type: 'llm_call',
      name: 'Classify urgency',
      config: { prompt: 'Reply URGENT or NORMAL: {{trigger.payload.text}}', max_tokens: 8 },
    },
    {
      step_order: 2,
      step_type: 'conditional_branch',
      name: 'Urgent?',
      config: {
        left: '{{steps.1.output.text}}',
        operator: 'contains',
        right: 'URGENT',
        then_step_order: 3,
        else_step_order: 4,
      },
    },
    { step_order: 3, step_type: 'approval_gate', name: 'Approve', config: {} },
    {
      step_order: 4,
      step_type: 'http_request',
      name: 'Fetch',
      config: { method: 'GET', url: 'https://api.github.com/zen' },
    },
  ];

  if (includePrivileged) {
    steps.push({
      step_order: 5,
      step_type: 'db_write',
      name: 'Record verdict',
      config: { label: 'verdict', payload: { v: '{{steps.1.output.text}}' } },
    });
  }

  return steps.map((step) => ({ ...step, id: crypto.randomUUID(), workflow_id: workflowId }));
};

const outcome = (response: { errorCode?: string; errorMessage?: string }) =>
  response.errorCode || response.errorMessage
    ? `DENIED (${(response.errorMessage ?? '').slice(0, 64)})`
    : 'OK';

const { check, report } = createReporter(54);

await sweepProbeFixtures();

const ownerA = await getToken('owner-a@example.com');
const editorA = await getToken('editor-a@example.com');
const viewerA = await getToken('viewer-a@example.com');

// --- an owner builds a workflow exactly as the UI does --------------------------------
const created = await roleRequest(ownerA, 'owner', CREATE_WORKFLOW, {
  object: { org_id: ORG_A_ID, name: `${PROBE_PREFIX} builder owner` },
});
const workflowId = (created.data?.insert_workflows_one as { id: string } | undefined)?.id ?? '';
check('owner creates a workflow', workflowId !== '', outcome(created));

const renamed = await roleRequest(ownerA, 'owner', UPDATE_WORKFLOW, {
  id: workflowId,
  set: { name: `${PROBE_PREFIX} builder owner renamed`, description: 'edited' },
});
check('owner renames it', renamed.errorCode === undefined, outcome(renamed));

const ownerSteps = buildSteps(workflowId, true);
const savedSteps = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_STEPS, {
  workflowId,
  keptIds: ownerSteps.map((step) => step.id),
  steps: ownerSteps,
});
check('owner saves five steps incl. db_write', savedSteps.errorCode === undefined, outcome(savedSteps));

const savedTriggers = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_TRIGGERS, {
  workflowId,
  keptIds: [],
  triggers: [
    {
      id: crypto.randomUUID(),
      workflow_id: workflowId,
      trigger_type: 'manual',
      is_enabled: true,
      config: {},
    },
  ],
});
check('owner saves a manual trigger', savedTriggers.errorCode === undefined, outcome(savedTriggers));

// Saving twice is the ordinary case — the builder upserts on every save, so the
// on_conflict path has to be reachable by the same role that inserted.
const resaved = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_STEPS, {
  workflowId,
  keptIds: ownerSteps.map((step) => step.id),
  steps: ownerSteps.map((step) => ({ ...step, name: `${step.name} v2` })),
});
check('owner re-saves (upsert path)', resaved.errorCode === undefined, outcome(resaved));

const existingTrigger = await adminRequest<{ workflow_triggers: { id: string }[] }>(
  `query T($workflowId: uuid!) {
     workflow_triggers(where: { workflow_id: { _eq: $workflowId } }) { id }
   }`,
  { workflowId },
).then((data) => data.workflow_triggers[0]?.id ?? '');

const retriggered = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_TRIGGERS, {
  workflowId,
  keptIds: [existingTrigger],
  triggers: [
    {
      id: existingTrigger,
      workflow_id: workflowId,
      trigger_type: 'manual',
      is_enabled: true,
      config: {},
    },
  ],
});
check('owner re-saves the trigger (upsert path)', retriggered.errorCode === undefined, outcome(retriggered));

// --- reordering, which is what the deferrable constraint exists for -------------------
const reordered = [...ownerSteps].reverse().map((step, index) => ({ ...step, step_order: index + 1 }));
const savedReorder = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_STEPS, {
  workflowId,
  keptIds: reordered.map((step) => step.id),
  steps: reordered,
});
check('owner reverses step order in one save', savedReorder.errorCode === undefined, outcome(savedReorder));

// --- removing a step -----------------------------------------------------------------
const kept = reordered.slice(0, 3);
const savedRemoval = await roleRequest(ownerA, 'owner', SAVE_WORKFLOW_STEPS, {
  workflowId,
  keptIds: kept.map((step) => step.id),
  steps: kept,
});
check('owner removes steps by omitting them', savedRemoval.errorCode === undefined, outcome(savedRemoval));

const afterRemoval = await roleRequest(ownerA, 'owner', WORKFLOW_DETAIL, { workflowId });
const remaining = (afterRemoval.data?.workflows_by_pk as { steps: unknown[] } | null)?.steps.length;
check('the removed steps are gone', remaining === 3, `steps=${remaining}`);

// --- an editor builds one too ---------------------------------------------------------
const editorCreated = await roleRequest(editorA, 'editor', CREATE_WORKFLOW, {
  object: { org_id: ORG_A_ID, name: `${PROBE_PREFIX} builder editor` },
});
const editorWorkflowId =
  (editorCreated.data?.insert_workflows_one as { id: string } | undefined)?.id ?? '';
check('editor creates a workflow', editorWorkflowId !== '', outcome(editorCreated));

const editorAllowed = await roleRequest(editorA, 'editor', SAVE_WORKFLOW_STEPS, {
  workflowId: editorWorkflowId,
  keptIds: buildSteps(editorWorkflowId, false).map((step) => step.id),
  steps: buildSteps(editorWorkflowId, false),
});
check('editor saves permitted step types', editorAllowed.errorCode === undefined, outcome(editorAllowed));

const editorPrivileged = buildSteps(editorWorkflowId, true);
const editorDenied = await roleRequest(editorA, 'editor', SAVE_WORKFLOW_STEPS, {
  workflowId: editorWorkflowId,
  keptIds: editorPrivileged.map((step) => step.id),
  steps: editorPrivileged,
});
check('editor is refused a db_write step', editorDenied.errorCode !== undefined, outcome(editorDenied));

// --- a viewer may do none of it -------------------------------------------------------
const viewerCreate = await roleRequest(viewerA, 'viewer', CREATE_WORKFLOW, {
  object: { org_id: ORG_A_ID, name: `${PROBE_PREFIX} builder viewer` },
});
check('viewer cannot create a workflow', viewerCreate.errorCode !== undefined, outcome(viewerCreate));

const viewerEdit = await roleRequest(viewerA, 'viewer', UPDATE_WORKFLOW, {
  id: workflowId,
  set: { name: 'viewer was here' },
});
check('viewer cannot rename one', viewerEdit.errorCode !== undefined, outcome(viewerEdit));

// --- delete ---------------------------------------------------------------------------
const editorDelete = await roleRequest(editorA, 'editor', DELETE_WORKFLOW, { id: editorWorkflowId });
const editorDeleted = (editorDelete.data?.delete_workflows_by_pk ?? null) !== null;
check('editor cannot delete a workflow', !editorDeleted || editorDelete.errorCode !== undefined, outcome(editorDelete));

const ownerDelete = await roleRequest(ownerA, 'owner', DELETE_WORKFLOW, { id: workflowId });
check('owner deletes a workflow', ownerDelete.errorCode === undefined, outcome(ownerDelete));

await adminRequest(
  `mutation Cleanup($ids: [uuid!]!) {
     delete_workflows(where: { id: { _in: $ids } }) { affected_rows }
   }`,
  { ids: [workflowId, editorWorkflowId].filter(Boolean) },
);

report();
