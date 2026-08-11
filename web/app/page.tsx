'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { useSession } from './providers';

export default function HomePage() {
  const { isLoading, userId } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    router.replace(userId ? '/workflows' : '/sign-in');
  }, [isLoading, userId, router]);

  return (
    <main className="mx-auto w-full max-w-3xl p-8">
      <Skeleton className="h-8 w-48" />
    </main>
  );
}
