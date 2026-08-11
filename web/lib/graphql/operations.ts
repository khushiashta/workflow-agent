export const MY_MEMBERSHIPS = `
  query MyMemberships {
    org_members(order_by: { created_at: asc }) {
      id
      org_id
      role
      organization {
        id
        name
        slug
      }
    }
  }
`;

export const ORG_USAGE = `
  query OrgUsage($orgId: uuid!) {
    org_usage_summary(where: { org_id: { _eq: $orgId } }) {
      org_id
      quota_calls_allowed
      quota_calls_used
      quota_calls_remaining
      runs_this_period
      failed_runs_this_period
      avg_run_seconds_this_period
    }
  }
`;

/**
 * Live so the counter moves the moment a run consumes its call. Quota enforcement that
 * only shows up as an error after the fact reads as arbitrary; watching it tick is the
 * cheapest evidence it is real.
 */
export const WATCH_ORG_USAGE = `
  subscription WatchOrgUsage($orgId: uuid!) {
    org_usage_summary(where: { org_id: { _eq: $orgId } }) {
      org_id
      quota_calls_allowed
      quota_calls_used
      quota_calls_remaining
      runs_this_period
      failed_runs_this_period
      avg_run_seconds_this_period
    }
  }
`;

/**
 * `runs(limit: 1)` is a per-parent limit, so Hasura compiles it to a lateral join rather
 * than one query per workflow — the list stays a single round trip.
 */
export const ORG_WORKFLOWS_WITH_LATEST_RUN = `
  query OrgWorkflowsWithLatestRun($orgId: uuid!) {
    workflows(where: { org_id: { _eq: $orgId } }, order_by: { created_at: desc }) {
      id
      org_id
      name
      description
      is_active
      steps(order_by: { step_order: asc }) {
        id
        step_order
        step_type
        name
        config
      }
      triggers {
        id
        trigger_type
        is_enabled
        config
      }
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        status
        trigger_type
        started_at
        finished_at
        created_at
      }
    }
  }
`;

export const WORKFLOW_DETAIL = `
  query WorkflowDetail($workflowId: uuid!) {
    workflows_by_pk(id: $workflowId) {
      id
      org_id
      name
      description
      is_active
      steps(order_by: { step_order: asc }) {
        id
        step_order
        step_type
        name
        config
      }
      triggers {
        id
        trigger_type
        is_enabled
        config
      }
      runs(order_by: { created_at: desc }, limit: 10) {
        id
        status
        trigger_type
        started_at
        finished_at
        created_at
      }
    }
  }
`;

export const CREATE_WORKFLOW = `
  mutation CreateWorkflow($object: workflows_insert_input!) {
    insert_workflows_one(object: $object) {
      id
    }
  }
`;

export const UPDATE_WORKFLOW = `
  mutation UpdateWorkflow($id: uuid!, $set: workflows_set_input!) {
    update_workflows_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
    }
  }
`;

/**
 * Root fields run in order inside one transaction, so removed steps are gone before the
 * rest are re-inserted. Reordering works because the uniqueness of
 * (workflow_id, step_order) is deferred to commit — a per-statement check would reject
 * the transient collision while positions are being swapped.
 */
export const SAVE_WORKFLOW_STEPS = `
  mutation SaveWorkflowSteps(
    $workflowId: uuid!
    $keptIds: [uuid!]!
    $steps: [workflow_steps_insert_input!]!
  ) {
    delete_workflow_steps(
      where: { workflow_id: { _eq: $workflowId }, id: { _nin: $keptIds } }
    ) {
      affected_rows
    }
    insert_workflow_steps(
      objects: $steps
      on_conflict: {
        constraint: workflow_steps_pkey
        update_columns: [step_order, step_type, name, config]
      }
    ) {
      affected_rows
    }
  }
`;

export const SAVE_WORKFLOW_TRIGGERS = `
  mutation SaveWorkflowTriggers(
    $workflowId: uuid!
    $keptIds: [uuid!]!
    $triggers: [workflow_triggers_insert_input!]!
  ) {
    delete_workflow_triggers(
      where: {
        workflow_id: { _eq: $workflowId }
        id: { _nin: $keptIds }
        trigger_type: { _neq: "webhook" }
      }
    ) {
      affected_rows
    }
    insert_workflow_triggers(
      objects: $triggers
      on_conflict: {
        constraint: workflow_triggers_pkey
        update_columns: [trigger_type, is_enabled, config]
      }
    ) {
      affected_rows
    }
  }
`;

export const DELETE_WORKFLOW = `
  mutation DeleteWorkflow($id: uuid!) {
    delete_workflows_by_pk(id: $id) {
      id
    }
  }
`;

export const TRIGGER_WORKFLOW_RUN = `
  mutation TriggerWorkflowRun($workflowId: uuid!, $payload: jsonb) {
    triggerWorkflowRun(workflow_id: $workflowId, payload: $payload) {
      workflow_run_id
      status
    }
  }
`;

export const APPROVE_STEP = `
  mutation ApproveStep($stepRunId: uuid!, $comment: String) {
    approveStep(step_run_id: $stepRunId, comment: $comment) {
      step_run_id
      workflow_run_id
      status
    }
  }
`;

export const CREATE_WEBHOOK_TRIGGER = `
  mutation CreateWebhookTrigger($workflowId: uuid!) {
    createWebhookTrigger(workflow_id: $workflowId) {
      workflow_trigger_id
      token
    }
  }
`;

export const RUN_DETAIL = `
  query RunDetail($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      trigger_type
      error
      started_at
      finished_at
      created_at
      workflow {
        id
        name
        org_id
      }
    }
  }
`;

/**
 * Two narrow subscriptions beat one nested one: Hasura re-evaluates and re-pushes the
 * whole result set on any change, so nesting steps under the run would re-send the run
 * on every step transition.
 */
export const WATCH_RUN = `
  subscription WatchRun($runId: uuid!) {
    workflow_runs_by_pk(id: $runId) {
      id
      status
      error
      started_at
      finished_at
    }
  }
`;

export const WATCH_STEP_RUNS = `
  subscription WatchStepRuns($runId: uuid!) {
    step_runs(where: { workflow_run_id: { _eq: $runId } }, order_by: { step_order: asc }) {
      id
      step_order
      status
      attempt_count
      input
      output
      error
      approved_at
      approval_comment
      started_at
      finished_at
      approver {
        id
        displayName
      }
      step {
        id
        name
        step_type
        config
      }
    }
  }
`;
