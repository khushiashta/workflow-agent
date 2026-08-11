import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

/**
 * Only the hash is stored. Reading a workflow_triggers row is then not the same as
 * holding the credential, which matters because the row is otherwise ordinary org data.
 * The plaintext is returned exactly once, at creation.
 */
export function mintWebhookToken(): { token: string; hash: string } {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyWebhookToken(provided: string, storedHash: string): boolean {
  const providedDigest = Buffer.from(hashToken(provided), 'hex');
  const storedDigest = Buffer.from(storedHash, 'hex');

  // Comparing digests rather than the tokens keeps the lengths equal, and
  // timingSafeEqual because token comparison is the one string comparison where how
  // long it takes to fail is itself information.
  if (providedDigest.length !== storedDigest.length) return false;
  return timingSafeEqual(providedDigest, storedDigest);
}
