/**
 * Shared plumbing for the verification scripts.
 *
 * Access tokens are cached on disk because nhost's brute-force limiter counts sign-ins,
 * and four suites each signing in four users will trip it within the window. Caching
 * also means the suites can be run back to back — which is the point, since they all get
 * re-run against the deployed backend.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN_TTL_MS = 10 * 60 * 1000; // access tokens live 15 minutes; refresh well before
const CACHE_PATH = join(tmpdir(), 'workflow-agent-tokens.json');

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

const authUrl = requireEnv('NHOST_AUTH_URL');
const graphqlUrl = requireEnv('NHOST_GRAPHQL_URL');
const adminSecret = requireEnv('NHOST_ADMIN_SECRET');
const password = requireEnv('SEED_USER_PASSWORD');

/** Reads the body as text first, so a non-JSON response says what it actually was. */
export async function readJson<T>(response: globalThis.Response, label: string): Promise<T> {
  const text = await response.text();
  if (!text) throw new Error(`${label}: empty body (HTTP ${response.status})`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label}: non-JSON body (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
}

type TokenCache = Record<string, { token: string; issuedAt: number; endpoint: string }>;

function readCache(): TokenCache {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as TokenCache;
  } catch {
    return {};
  }
}

function writeCache(cache: TokenCache) {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf8');
  } catch {
    // A cache we cannot write is a performance loss, not a correctness problem.
  }
}

export async function getToken(email: string): Promise<string> {
  const cache = readCache();
  const cached = cache[email];
  // Keyed by endpoint so switching between local and cloud never reuses the wrong token.
  if (cached && cached.endpoint === authUrl && Date.now() - cached.issuedAt < TOKEN_TTL_MS) {
    return cached.token;
  }

  const response = await fetch(`${authUrl}/signin/email-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (response.status === 429) {
    throw new Error(
      `sign-in ${email}: rate limited (429). nhost's brute-force limiter counts sign-ins; ` +
        'wait a minute or clear the token cache less often.',
    );
  }

  const body = await readJson<{ session?: { accessToken?: string } }>(response, `sign-in ${email}`);
  const token = body.session?.accessToken;
  if (!token) throw new Error(`Sign-in failed for ${email}`);

  cache[email] = { token, issuedAt: Date.now(), endpoint: authUrl };
  writeCache(cache);
  return token;
}

export async function adminRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': adminSecret },
    body: JSON.stringify({ query, variables }),
  });

  const body = await readJson<{ data?: T; errors?: { message: string }[] }>(
    response,
    'admin request',
  );
  if (body.errors?.length) throw new Error(body.errors.map((error) => error.message).join('; '));
  if (!body.data) throw new Error('admin request returned no data');
  return body.data;
}

export type RoleResponse = {
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
};

/** Runs an operation as a real user with an explicit x-hasura-role. */
export async function roleRequest(
  token: string,
  role: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<RoleResponse> {
  const response = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-hasura-role': role,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await readJson<{
    data?: Record<string, unknown>;
    errors?: { message: string; extensions?: { code?: string } }[];
  }>(response, `request as ${role}`);

  if (body.errors?.length) {
    const first = body.errors[0];
    return { errorCode: first?.extensions?.code, errorMessage: first?.message };
  }
  return { data: body.data };
}

export type Result = { ok: boolean; line: string };

export function createReporter(labelWidth = 56) {
  const results: Result[] = [];

  return {
    check(label: string, ok: boolean, detail: string) {
      results.push({ ok, line: `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(labelWidth)} ${detail}` });
    },
    report(): never {
      for (const result of results) console.log(result.line);
      const failed = results.filter((result) => !result.ok);
      console.log(`\n${results.length - failed.length}/${results.length} passed`);
      process.exit(failed.length > 0 ? 1 : 0);
    },
  };
}
