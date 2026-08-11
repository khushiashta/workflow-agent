import { createClient } from '@nhost/nhost-js';

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
const region = process.env.NEXT_PUBLIC_NHOST_REGION;

if (!subdomain) {
  throw new Error('NEXT_PUBLIC_NHOST_SUBDOMAIN is not set. See web/.env.example.');
}

export const nhost = createClient({ subdomain, region: region || undefined });

export const graphqlUrl = `https://${subdomain}.graphql.${region ? `${region}.` : 'local.'}nhost.run/v1`;

/** Same host, ws scheme — what graphql-ws needs for subscriptions. */
export const graphqlWsUrl = graphqlUrl.replace(/^https/, 'wss');
