import { nhost } from '@/lib/nhost/client';
import type { OrgRole } from '@/lib/types/database';

/**
 * Carries the code the Action handlers set in `extensions`, so the UI can say something
 * specific — "quota exhausted for this period" — instead of a generic failure.
 */
export class GraphQLRequestError extends Error {
  code: string;
  role: OrgRole | undefined;

  constructor(message: string, code: string, role?: OrgRole) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.code = code;
    this.role = role;
  }
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  'quota-exhausted': 'This organization has used its whole allowance for the period.',
  conflict: 'Someone else got there first — this step is no longer awaiting approval.',
  'validation-failed': 'Your role cannot perform this action.',
  forbidden: 'Your role cannot perform this action.',
  'not-found': 'That item does not exist, or it belongs to another organization.',
};

/**
 * Hasura reports a failed row-level rule as "check constraint of an insert/update
 * permission has failed", which names neither the rule nor the role that failed it. Two
 * quite different causes produce it here — an owner-only step or trigger type, or a role
 * that does not match the caller's membership in the target organization — so the message
 * names the acting role. Without that, diagnosing it means guessing.
 */
function translateHasuraMessage(message: string, role: OrgRole | undefined): string | null {
  if (message.includes('check constraint of an insert/update permission has failed')) {
    const acting = role ? ` (acting as ${role})` : '';
    return `Your role cannot save this${acting}. Only an owner can add a database write or notify step, or a webhook trigger — and you must hold the role you are acting as in this organization. If you just deployed, reload the page to pick up the current session.`;
  }
  if (message.includes('not found in type')) {
    return 'Your role cannot read or write one of these fields.';
  }
  return null;
}

export function describeError(error: unknown): string {
  if (error instanceof GraphQLRequestError) {
    return (
      translateHasuraMessage(error.message, error.role) ??
      FRIENDLY_MESSAGES[error.code] ??
      error.message
    );
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

/**
 * Sends x-hasura-role for the caller's role in the *active* organization, because Hasura
 * resolves one role per request while a membership is per organization. A tampered header
 * only changes which permission set applies: every rule additionally requires a matching
 * org_members row, so claiming a role you do not hold matches nothing.
 */
export async function request<T>(
  query: string,
  variables: Record<string, unknown> = {},
  role?: OrgRole,
): Promise<T> {
  const response = await nhost.graphql.request<T>(
    { query, variables },
    role ? { headers: { 'x-hasura-role': role } } : undefined,
  );

  const errors = response.body.errors;
  if (errors?.length) {
    const first = errors[0];
    const code = (first?.extensions?.code as string | undefined) ?? 'unknown';
    throw new GraphQLRequestError(first?.message ?? 'GraphQL error', code, role);
  }

  const data = response.body.data;
  if (!data) throw new GraphQLRequestError('No data returned', 'empty-response', role);
  return data;
}
