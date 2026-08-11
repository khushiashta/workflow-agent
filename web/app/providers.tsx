'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { request } from '@/lib/graphql/client';
import { MY_MEMBERSHIPS } from '@/lib/graphql/operations';
import { nhost } from '@/lib/nhost/client';
import type { OrgMembership } from '@/lib/types/database';

const ACTIVE_ORG_KEY = 'workflow-agent:active-org';

type SessionState = {
  isLoading: boolean;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  memberships: OrgMembership[];
  activeOrgId: string | null;
  setActiveOrgId: (orgId: string) => void;
  refreshMemberships: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState | null>(null);

export function Providers({ children }: { children: React.ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<OrgMembership[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);

  const loadMemberships = useCallback(async () => {
    // Runs under the JWT's default `user` role, whose only permission is the caller's own
    // membership rows. This is the bootstrap: the app cannot choose an x-hasura-role until
    // it knows which organizations the caller belongs to and as what.
    const data = await request<{ org_members: OrgMembership[] }>(MY_MEMBERSHIPS);
    const list = data.org_members;
    setMemberships(list);

    setActiveOrgId((current) => {
      if (current && list.some((membership) => membership.org_id === current)) return current;
      const remembered = window.localStorage.getItem(ACTIVE_ORG_KEY);
      if (remembered && list.some((membership) => membership.org_id === remembered)) {
        return remembered;
      }
      return list.at(0)?.org_id ?? null;
    });
  }, []);

  const applySession = useCallback(
    async (session: ReturnType<typeof nhost.getUserSession>) => {
      if (!session?.user) {
        setUserId(null);
        setEmail(null);
        setDisplayName(null);
        setMemberships([]);
        setActiveOrgId(null);
        setIsLoading(false);
        return;
      }

      setUserId(session.user.id);
      setEmail(session.user.email ?? null);
      setDisplayName(session.user.displayName ?? null);
      await loadMemberships();
      setIsLoading(false);
    },
    [loadMemberships],
  );

  useEffect(() => {
    let active = true;

    const bootstrap = async () => {
      // Refresh first: a stored session whose access token has expired would otherwise
      // make every query fail once before recovering.
      await nhost.refreshSession(60).catch(() => null);
      if (active) await applySession(nhost.getUserSession());
    };

    void bootstrap();
    const unsubscribe = nhost.sessionStorage.onChange(() => {
      void applySession(nhost.getUserSession());
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [applySession]);

  const chooseOrg = useCallback((orgId: string) => {
    window.localStorage.setItem(ACTIVE_ORG_KEY, orgId);
    setActiveOrgId(orgId);
  }, []);

  const signOut = useCallback(async () => {
    const session = nhost.getUserSession();
    if (session?.refreshToken) {
      await nhost.auth.signOut({ refreshToken: session.refreshToken }).catch(() => null);
    }
    nhost.clearSession();
    setUserId(null);
    setMemberships([]);
    setActiveOrgId(null);
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      isLoading,
      userId,
      email,
      displayName,
      memberships,
      activeOrgId,
      setActiveOrgId: chooseOrg,
      refreshMemberships: loadMemberships,
      signOut,
    }),
    [isLoading, userId, email, displayName, memberships, activeOrgId, chooseOrg, loadMemberships, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside <Providers>');
  return context;
}

/**
 * The active membership is what every request's x-hasura-role is taken from, so it is
 * deliberately a single source rather than something each component derives.
 */
export function useActiveMembership(): OrgMembership | null {
  const { memberships, activeOrgId } = useSession();
  return useMemo(
    () => memberships.find((membership) => membership.org_id === activeOrgId) ?? null,
    [memberships, activeOrgId],
  );
}
