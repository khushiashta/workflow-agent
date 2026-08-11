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

const REQUIRED_ROLES = ['owner', 'editor', 'viewer'];

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('Access token is not a JWT');
  const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  const claims = JSON.parse(json) as Record<string, unknown>;
  return (claims['https://hasura.io/jwt/claims'] as Record<string, unknown>) ?? {};
}

/**
 * The whole permission model rests on a JWT that carries owner, editor and viewer as
 * allowed roles. When it does not, every rule written for those roles matches zero rows
 * and the app looks comprehensively broken for a reason that has nothing to do with
 * permissions. Failing here, by name, is worth more than any amount of downstream
 * debugging.
 */
export function assertRolesGranted(token: string): void {
  const claims = decodeJwtClaims(token);
  const allowed = (claims['x-hasura-allowed-roles'] as string[] | undefined) ?? [];
  const missing = REQUIRED_ROLES.filter((role) => !allowed.includes(role));

  if (missing.length > 0) {
    throw new Error(
      `This backend does not grant ${missing.join(', ')} as allowed roles ` +
        `(token carries: ${allowed.join(', ') || 'none'}).\n` +
        '  nhost/nhost.toml sets auth.user.roles.allowed, so the config has not reached ' +
        'this project yet.\n' +
        '  Locally: restart with `nhost up`.\n' +
        '  In the cloud: connect the GitHub repo in the nhost dashboard so a push applies ' +
        'the config, or run `nhost config apply`.',
    );
  }
}

/**
 * Confirms the backend is reachable, authenticated, and carrying the schema, before a
 * suite reports a wall of failures that all mean one of those three things.
 *
 * The three causes need different fixes, so they get different messages. Reporting a
 * rejected admin secret as "schema not deployed" sends you to the dashboard to debug a
 * deployment that may be perfectly fine.
 */
export async function assertSchemaDeployed(): Promise<void> {
  const envFile = process.env.ENV_FILE ?? '.env';

  try {
    await adminRequest('query SchemaProbe { organizations(limit: 1) { id } }');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);

    if (/admin-secret|access-key|unauthoriz/i.test(message)) {
      throw new Error(
        `The backend rejected the admin secret (${message}).\n` +
          `  Endpoint: ${graphqlUrl}\n` +
          `  NHOST_ADMIN_SECRET in ${envFile} does not match this project. Read it from the\n` +
          '  nhost dashboard under Settings -> Hasura. The local value from .secrets\n' +
          '  ("nhost-admin-secret") only works against `nhost up`.',
      );
    }

    if (/not found in type|Unknown type|field .* not found/i.test(message)) {
      throw new Error(
        `The workflow schema is not present on this backend (${message}).\n` +
          `  Endpoint: ${graphqlUrl}\n` +
          '  nhost applies nhost/migrations and nhost/metadata from the connected GitHub\n' +
          '  repo, so connect it in the dashboard and push.',
      );
    }

    throw new Error(`Could not reach ${graphqlUrl}: ${message}`);
  }
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

/**
 * Every fixture a suite creates carries this prefix so it can be swept.
 *
 * Cleanup at the end of a suite only runs when the suite finishes: the first time one
 * died partway through, its workflows stayed in the org and showed up in the app. Sweeping
 * on entry means a crashed run cannot leave anything behind for the next one — or for a
 * recorded walkthrough.
 */
export const PROBE_PREFIX = '[probe]';

export async function sweepProbeFixtures(): Promise<void> {
  await adminRequest(
    `mutation SweepProbeFixtures($namePattern: String!, $slugPattern: String!) {
       delete_workflows(where: { name: { _like: $namePattern } }) { affected_rows }
       delete_organizations(where: { slug: { _like: $slugPattern } }) { affected_rows }
     }`,
    { namePattern: `${PROBE_PREFIX}%`, slugPattern: 'probe-%' },
  );
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
