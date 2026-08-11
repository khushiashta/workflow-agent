import { nhost } from '@/lib/nhost/client';
import type { OrgRole } from '@/lib/types/database';

/**
 * Carries the code the Action handlers set in `extensions`, so the UI can say something
 * specific — "quota exhausted for this period" — instead of a generic failure.
 */
export class GraphQLRequestError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'GraphQLRequestError';
    this.code = code;
  }
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  'quota-exhausted': 'This organization has used its whole allowance for the period.',
  conflict: 'Someone else got there first — this step is no longer awaiting approval.',
  'validation-failed': 'Your role cannot perform this action.',
};

export function describeError(error: unknown): string {
  if (error instanceof GraphQLRequestError) {
    return FRIENDLY_MESSAGES[error.code] ?? error.message;
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
    throw new GraphQLRequestError(first?.message ?? 'GraphQL error', code);
  }

  const data = response.body.data;
  if (!data) throw new GraphQLRequestError('No data returned', 'empty-response');
  return data;
}
