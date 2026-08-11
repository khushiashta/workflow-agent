'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSession } from '@/app/providers';
import { OrgSwitcher } from '@/components/org/org-switcher';
import { QuotaIndicator } from '@/components/org/quota-indicator';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function AppLayout({ children }: LayoutProps<'/'>) {
  const { isLoading, userId, email, signOut } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !userId) router.replace('/sign-in');
  }, [isLoading, userId, router]);

  if (isLoading || !userId) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-32 w-full" />
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-4 px-6 py-3">
          <Link href="/workflows" className="text-sm font-semibold">
            Workflow Builder
          </Link>

          <OrgSwitcher />

          <div className="ml-auto flex items-center gap-6">
            <QuotaIndicator />
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">{email}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await signOut();
                  router.replace('/sign-in');
                }}
              >
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 p-6">{children}</main>
    </div>
  );
}
