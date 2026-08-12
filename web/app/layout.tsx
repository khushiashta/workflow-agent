import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Providers } from './providers';
import './globals.css';

// Named --font-sans / --font-mono because that is what globals.css maps Tailwind's
// font utilities to. The scaffold named them --font-geist-*, leaving --font-sans
// defined as var(--font-sans) — self-referential, so it resolved to nothing and every
// surface fell back to the browser's default serif.
const sans = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
});

// The UI is dense with prompts, JSON, ids and tokens, so the mono face does real work.
const mono = JetBrains_Mono({
  variable: '--font-mono',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'AI Agent Workflow Builder',
  description: 'Chain AI agent steps into workflows, with org-scoped roles and approval gates',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background font-sans text-foreground antialiased">
        <Providers>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster richColors position="top-right" />
        </Providers>
      </body>
    </html>
  );
}
