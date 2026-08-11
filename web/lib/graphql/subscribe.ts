import { type Client, createClient } from 'graphql-ws';
import { graphqlWsUrl, nhost } from '@/lib/nhost/client';
import type { OrgRole } from '@/lib/types/database';

/**
 * One client per role, because connection params are fixed at connect time: switching
 * organizations without reconnecting would leave the socket authenticated as the previous
 * role, and the subscription would keep streaming — or silently stream nothing — under the
 * wrong permission set.
 *
 * connectionParams is a function so a reconnect re-reads the session and picks up a token
 * refreshed since the socket first opened.
 */
export function createWsClient(role: OrgRole): Client {
  return createClient({
    url: graphqlWsUrl,
    lazy: true,
    retryAttempts: 10,
    connectionParams: () => {
      const session = nhost.getUserSession();
      return {
        headers: {
          ...(session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
          'x-hasura-role': role,
        },
      };
    },
  });
}
