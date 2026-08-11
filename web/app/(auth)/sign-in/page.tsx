'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/app/providers';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { nhost } from '@/lib/nhost/client';

const DEMO_ACCOUNTS = [
  { email: 'owner-a@example.com', label: 'Org A · owner' },
  { email: 'editor-a@example.com', label: 'Org A · editor' },
  { email: 'viewer-a@example.com', label: 'Org A · viewer' },
  { email: 'owner-b@example.com', label: 'Org B · owner' },
];

export default function SignInPage() {
  const { userId, isLoading } = useSession();
  const router = useRouter();

  const [email, setEmail] = useState('owner-a@example.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && userId) router.replace('/workflows');
  }, [isLoading, userId, router]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await nhost.auth.signInEmailPassword({ email, password });
      // The session provider watches session storage, so navigation happens once it
      // reports a user rather than being raced here.
      router.replace('/workflows');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>AI Agent Workflow Builder</CardTitle>
          <CardDescription>Sign in to your organization</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <div className="mt-6 space-y-2 border-t pt-4">
            <p className="text-xs text-muted-foreground">
              Demo accounts — pick one, then enter the seeded password.
            </p>
            <div className="flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((account) => (
                <Button
                  key={account.email}
                  type="button"
                  variant={email === account.email ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => setEmail(account.email)}
                >
                  {account.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
