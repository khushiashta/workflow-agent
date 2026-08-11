import { z } from 'zod';
import { classifyHttpFailure, PermanentError, TransientError } from '../retry.ts';
import { resolveTemplates } from '../template.ts';
import type { StepExecutor } from '../types.ts';

const configSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
]);

const MAX_REDIRECTS = 3;
const MAX_STORED_BODY_CHARS = 8_000;

function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd')) return true;

  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;

  const [a, b] = parts.map(Number) as [number, number, number, number];
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * The URL comes from whoever authored the workflow, so without this the step is a
 * server-side request forgery primitive aimed at the cloud metadata endpoint and every
 * internal service the function can reach.
 */
function assertUrlIsAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PermanentError(`Not a valid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PermanentError(`Only http and https URLs are allowed, got ${url.protocol}`);
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase()) || isPrivateAddress(url.hostname)) {
    throw new PermanentError(`Requests to internal addresses are not allowed: ${url.hostname}`);
  }
  return url;
}

export const executeHttpRequest: StepExecutor = async ({ step, context }) => {
  const config = configSchema.parse(resolveTemplates(step.config, context));

  let target = assertUrlIsAllowed(config.url);
  let response: globalThis.Response | undefined;

  // Redirects are followed by hand so every hop is re-checked. An allowed host that
  // 302s to an internal one would otherwise walk straight past the guard above.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      response = await fetch(target, {
        method: config.method,
        headers: { accept: 'application/json', ...config.headers },
        body:
          config.method === 'GET' || config.body === undefined
            ? undefined
            : JSON.stringify(config.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(config.timeout_ms ?? 15_000),
      });
    } catch (error) {
      throw new TransientError(`Request failed: ${(error as Error).message}`);
    }

    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    if (!location) break;
    if (hop === MAX_REDIRECTS) throw new PermanentError('Too many redirects');
    target = assertUrlIsAllowed(new URL(location, target).toString());
  }

  if (!response) throw new TransientError('Request produced no response');

  const rawBody = await response.text();
  if (!response.ok) throw classifyHttpFailure(response.status, rawBody);

  let parsed: unknown = rawBody.slice(0, MAX_STORED_BODY_CHARS);
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Plain-text responses are legitimate; keep the truncated string.
  }

  return {
    output: {
      status: response.status,
      url: target.toString(),
      body: parsed,
      truncated: rawBody.length > MAX_STORED_BODY_CHARS,
    },
  };
};
