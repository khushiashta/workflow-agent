'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, request } from '@/lib/graphql/client';
import type { OrgRole } from '@/lib/types/database';

type QueryState<T> = {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => void;
};

/**
 * Pass `query: null` to hold off — the common case is waiting for the active role, and a
 * request sent before it is known would run under the wrong permission set and quietly
 * return nothing.
 */
export function useQuery<T>(
  query: string | null,
  variables: Record<string, unknown> = {},
  role?: OrgRole,
): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(Boolean(query));
  const [reloadToken, setReloadToken] = useState(0);

  const serializedVariables = JSON.stringify(variables);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (!query) {
      setIsLoading(false);
      return;
    }

    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    setIsLoading(true);

    request<T>(query, JSON.parse(serializedVariables), role)
      .then((result) => {
        // Ignore a response that has been superseded — switching orgs quickly would
        // otherwise let an older request paint over the newer one.
        if (latestRequest.current !== requestId) return;
        setData(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (latestRequest.current !== requestId) return;
        setError(describeError(cause));
      })
      .finally(() => {
        if (latestRequest.current === requestId) setIsLoading(false);
      });
  }, [query, serializedVariables, role, reloadToken]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  return { data, error, isLoading, refetch };
}
