import { createClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN ?? '';
const region = process.env.NEXT_PUBLIC_NHOST_REGION ?? '';

/**
 * Reported rather than thrown. Pages are prerendered at build time, so throwing here for a
 * missing runtime value fails the whole build with a stack trace — and on a host that
 * means a deployment serving nothing but 404s, which looks like a routing problem rather
 * than a missing variable. The app renders the message instead.
 */
export const nhostConfigError = subdomain
  ? null
  : 'NEXT_PUBLIC_NHOST_SUBDOMAIN is not set. See web/.env.example, and set it for every environment on your host.';

export const nhost = createClient({
  subdomain: subdomain || 'unconfigured',
  region: region || undefined,
});

export const graphqlUrl = `https://${subdomain || 'unconfigured'}.graphql.${
  region ? `${region}.` : 'local.'
}nhost.run/v1`;

/** Same host, ws scheme — what graphql-ws needs for subscriptions. */
export const graphqlWsUrl = graphqlUrl.replace(/^https/, 'wss');
