/**
 * GraphQL client bound to the admin secret, which bypasses every permission.
 *
 * That is exactly why each handler authorizes the caller explicitly before using it. If
 * a handler queries through here before checking membership, that query is the
 * vulnerability regardless of what the code does afterwards.
 */

const graphqlUrl = process.env.NHOST_GRAPHQL_URL;
const adminSecret = process.env.NHOST_ADMIN_SECRET;

export async function adminRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  if (!graphqlUrl || !adminSecret) {
    throw new Error('NHOST_GRAPHQL_URL and NHOST_ADMIN_SECRET must be set');
  }

  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': adminSecret },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors.map((error) => error.message).join('; ')}`);
  }
  if (!body.data) {
    throw new Error(`GraphQL returned no data (HTTP ${response.status})`);
  }
  return body.data;
}

export const nowIso = () => new Date().toISOString();
