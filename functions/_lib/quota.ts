import { adminRequest } from './admin-client.ts';
import { quotaExhausted } from './errors.ts';

const CONSUME_QUOTA = `
  mutation ConsumeOrgQuota($orgId: uuid!) {
    consume_org_quota(args: { target_org_id: $orgId }) {
      id
      quota_calls_used
      quota_calls_allowed
    }
  }
`;

export function assertQuotaAvailable(organization: {
  quota_calls_used: number;
  quota_calls_allowed: number;
}) {
  // Up front, so an exhausted org is refused rather than half-executed.
  if (organization.quota_calls_used >= organization.quota_calls_allowed) throw quotaExhausted();
}

/**
 * Consumed on completion, so a failed run costs nothing. The increment is guarded
 * inside consume_org_quota rather than read-then-written here: concurrent runs would
 * otherwise both observe headroom and overshoot the allowance. Zero rows back means the
 * allowance was already spent.
 *
 * Under a concurrent burst several runs can start against one remaining call and only
 * one will consume it. Reserve-then-release closes that at the cost of compensation on
 * every failure path; at this scale the guarded increment is the better trade.
 */
export async function consumeQuota(orgId: string): Promise<void> {
  const { consume_org_quota: consumed } = await adminRequest<{
    consume_org_quota: { quota_calls_used: number }[];
  }>(CONSUME_QUOTA, { orgId });

  if (consumed.length === 0) throw quotaExhausted();
}
