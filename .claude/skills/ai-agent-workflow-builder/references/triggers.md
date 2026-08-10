# Triggers

All four converge on the same two functions — `createRun` then `executeRun` — differing only in
how they authorize and what they record as `trigger_type`. Keep it that way: a trigger with its
own execution path is a trigger whose bugs are invisible from the others' tests.

| Type | Entry point | Authorized by |
|---|---|---|
| `manual` | `triggerWorkflowRun` Action | JWT session variables + `org_members` role |
| `webhook` | `startWorkflowRunViaWebhook` Action, role `public` | per-trigger token, timing-safe compared against `webhook_secret_hash` |
| `scheduled` | Hasura Cron Trigger → `/cron/scheduled-runs` | shared secret header; org comes from the workflow row |
| `database_event` | Hasura Event Trigger → `/events/document-created` | shared secret header; org comes from the changed row |

The three non-manual paths have no user, so `triggered_by` is `null` and the *trigger row* is the
authorization subject. That's why creating a `webhook` trigger is owner-only in layer 2: it mints
an unauthenticated door into the org's workflows, which is a different class of act from adding
an `llm_call` step.

## Webhook

Mint the token when the trigger is created — by the handler that has the admin secret, not the
client — return the plaintext exactly once, and store only the hash:

```ts
const token = randomBytes(32).toString('base64url');
const webhookSecretHash = createHash('sha256').update(token).digest('hex');
```

Show it in the UI with a "copy now, you won't see it again" affordance. Storing plaintext would
mean a read of `workflow_triggers` is a read of the credential, which is the whole reason the
column is excluded from every select permission.

Call it with no login:

```bash
curl -s "$NHOST_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  -d '{
    "query": "mutation ($id: uuid!, $token: String!, $payload: jsonb) { startWorkflowRunViaWebhook(workflow_id: $id, token: $token, payload: $payload) { workflow_run_id status } }",
    "variables": {
      "id": "'"$WORKFLOW_ID"'",
      "token": "'"$WEBHOOK_TOKEN"'",
      "payload": { "text": "Customer says the checkout page is completely broken" }
    }
  }'
```

The payload lands in `workflow_runs.context.trigger.payload`, reachable from step configs as
`{{trigger.payload.text}}`. That's how the same workflow behaves differently per caller without
being edited.

Rate-limit by trigger id — an open endpoint that creates rows is a denial-of-wallet vector even
with quota, since exhausting the quota is itself the damage. A per-trigger counter with a short
window is enough at this scope.

## Scheduled

Hasura Cron Trigger, in `metadata/cron_triggers.yaml`:

```yaml
- name: scheduled_workflow_runs
  webhook: '{{NHOST_FUNCTIONS_URL}}/cron/scheduled-runs'
  schedule: '*/5 * * * *'
  include_in_metadata: true
  payload: {}
  retry_conf:
    num_retries: 2
    retry_interval_seconds: 30
    timeout_seconds: 60
  headers:
    - name: x-webhook-secret
      value_from_env: NHOST_WEBHOOK_SECRET
  comment: Starts workflows whose scheduled trigger is due and resumes stalled runs
```

One cron entry sweeps all schedules rather than one Hasura cron per workflow — schedules are user
data that changes at runtime, and metadata is deploy-time config. Registering a cron per workflow
means every schedule edit is a metadata mutation, which is both slower and a much larger blast
radius.

The handler does two jobs:

```ts
export default async function handler(req: Request, res: Response) {
  assertWebhookSecret(req);

  const dueTriggers = await fetchDueScheduledTriggers();
  for (const trigger of dueTriggers) {
    if (!hasQuotaHeadroom(trigger.workflow.organization)) continue;
    const run = await createRun({ ...fromTrigger(trigger), triggerType: 'scheduled' });
    await executeRun(run.id);
    await markScheduleRan(trigger.id);
  }

  // A serverless invocation that dies mid-run leaves the row `running`. Anything whose
  // heartbeat has gone stale is resumed from its recorded step rather than restarted.
  const stalled = await fetchStalledRuns({ olderThanSeconds: 120 });
  for (const run of stalled) await executeRun(run.id);

  return res.status(200).json({
    started: dueTriggers.length,
    resumed: stalled.length,
  });
}
```

Compute due-ness from `config.cron` and `config.last_run_at` with a cron parser
(`cron-parser`), and stamp `last_run_at` **before** executing so a slow run doesn't get started
again by the next sweep. Skipping — rather than failing — a trigger whose org is out of quota
keeps a schedule from filling the run history with failures every five minutes.

Runs the sweeper resumes must be resumed, not restarted: `executeRun` reads
`resume_from_step_order`, and every step claim is conditional, so a step that already succeeded is
skipped rather than re-executed. That property is what makes at-least-once cron delivery safe
here.

## Database event

Event Trigger on `incoming_documents`, in `metadata/tables.yaml` under that table:

```yaml
event_triggers:
  - name: incoming_document_created
    definition:
      enable_manual: false
      insert:
        columns: '*'
    webhook: '{{NHOST_FUNCTIONS_URL}}/events/document-created'
    retry_conf:
      num_retries: 3
      interval_sec: 15
      timeout_sec: 60
    headers:
      - name: x-webhook-secret
        value_from_env: NHOST_WEBHOOK_SECRET
```

```ts
export default async function handler(req: Request, res: Response) {
  assertWebhookSecret(req);

  const { event } = req.body as HasuraEventPayload<IncomingDocumentRow>;
  const document = event.data.new;
  if (!document) return res.status(200).json({ skipped: 'no new row' });

  const triggers = await fetchDatabaseEventTriggers({
    orgId: document.org_id,
    table: 'incoming_documents',
    operation: 'insert',
  });

  const runIds: string[] = [];
  for (const trigger of triggers) {
    const run = await createRun({
      workflowId: trigger.workflow_id,
      orgId: document.org_id,
      triggerType: 'database_event',
      triggeredBy: null,
      payload: { document },
    });
    await executeRun(run.id);
    runIds.push(run.id);
  }

  return res.status(200).json({ started: runIds });
}
```

Two constraints the payload imposes. The org must come from `document.org_id` and the matching
triggers must be filtered to that org — otherwise a row inserted in Org B starts Org A's
workflows, which is a cross-org breach through the back door where nobody looks for one. And
Hasura event delivery is at-least-once, so a retry after a timeout redelivers the same event;
returning 200 promptly and relying on conditional claiming is what keeps a redelivery from
producing a second execution. Deriving the run's identity from the event (an idempotency key in
`context`) lets you skip the duplicate outright, which is the cheaper version of the same
guarantee.

## `notify` as an Event Trigger

The `notify` step inserts into `notifications`; an Event Trigger on that insert delivers it.

```yaml
event_triggers:
  - name: notification_queued
    definition:
      enable_manual: true
      insert:
        columns: '*'
    webhook: '{{NHOST_FUNCTIONS_URL}}/events/deliver-notification'
    retry_conf:
      num_retries: 3
      interval_sec: 10
      timeout_sec: 30
    headers:
      - name: x-webhook-secret
        value_from_env: NHOST_WEBHOOK_SECRET
```

The handler posts to `SLACK_WEBHOOK_URL` (or sends mail), then updates the row to `sent` or
`failed` with `delivery_error`. Set `enable_manual: true` so a failed delivery can be re-fired
from the console without inserting a duplicate row.

The reason `notify` isn't just a `fetch` inside the engine: run latency would then depend on
Slack being up, and a Slack outage would fail otherwise-successful runs. Handing delivery to the
event system gives at-least-once semantics with backoff that you didn't have to write, and the
`notifications` row is a durable record of what was attempted. The tradeoff is that step success
means "queued, not delivered" — surface `notifications.status` in the run view so that
distinction is visible rather than assumed.

## Shared secret verification

```ts
// _lib/webhook-secret.ts
export function assertWebhookSecret(req: Request) {
  const provided = req.header('x-webhook-secret');
  const expected = process.env.NHOST_WEBHOOK_SECRET;

  if (!expected) throw new HandlerError('Webhook secret not configured', 'misconfigured', 500);
  if (!provided || provided.length !== expected.length) throw forbidden('Invalid webhook secret');
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    throw forbidden('Invalid webhook secret');
  }
}
```

Event and cron handlers are HTTP endpoints on the public internet. Without this check, anyone who
learns the function URL can forge a row-change event and start runs in any org — the header is the
only thing distinguishing Hasura from an arbitrary caller. Fail closed when the env var is
missing rather than skipping verification in development, since "it worked locally" is exactly how
that check reaches production disabled.
