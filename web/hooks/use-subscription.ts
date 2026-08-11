'use client';

import { useEffect, useState } from 'react';
import { createWsClient } from '@/lib/graphql/subscribe';
import type { OrgRole } from '@/lib/types/database';

type SubscriptionState<T> = {
  data: T | null;
  error: string | null;
  isConnected: boolean;
};

/**
 * Pass `query: null` to hold off until the role is known. A subscription opened without an
 * explicit role falls back to the JWT default, which has no permission on these tables — it
 * would connect happily and then deliver nothing, which reads as "live updates are broken"
 * rather than as a missing header.
 *
 * The client is created inside the effect rather than memoized outside it. A disposed
 * graphql-ws client cannot be reused, and StrictMode's mount / unmount / remount in
 * development would dispose a memoized client on the first unmount and then re-subscribe
 * on the dead one — a socket that never connects and never errors.
 */
export function useSubscription<T>(
  query: string | null,
  variables: Record<string, unknown>,
  role: OrgRole | undefined,
): SubscriptionState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const serializedVariables = JSON.stringify(variables);

  useEffect(() => {
    if (!query || !role) return;

    const client = createWsClient(role);

    const unsubscribe = client.subscribe<T>(
      { query, variables: JSON.parse(serializedVariables) },
      {
        next: (message) => {
          if (message.errors?.length) {
            setError(message.errors[0]?.message ?? 'Subscription error');
            return;
          }
          if (message.data) {
            setData(message.data);
            setError(null);
            setIsConnected(true);
          }
        },
        error: (cause) => {
          setIsConnected(false);
          setError(cause instanceof Error ? cause.message : 'Live updates disconnected');
        },
        complete: () => setIsConnected(false),
      },
    );

    return () => {
      void unsubscribe();
      void client.dispose();
    };
  }, [query, serializedVariables, role]);

  return { data, error, isConnected };
}
