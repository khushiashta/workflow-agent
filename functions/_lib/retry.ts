export const MAX_STEP_ATTEMPTS = 2;

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

/**
 * Retrying a 400 is worse than not retrying: it doubles latency, doubles spend on a
 * metered API, and hides the actual bug. Only 408, 429 and 5xx are worth a second
 * attempt — everything else in the 4xx range means the request itself is wrong, and a
 * retry reproduces it exactly.
 */
export function classifyHttpFailure(status: number, detail: string): Error {
  const message = `Upstream responded ${status}: ${detail.slice(0, 200)}`;
  return status === 408 || status === 429 || status >= 500
    ? new TransientError(message)
    : new PermanentError(message);
}

/**
 * Carries how many attempts were actually spent. Without it the caller has to guess,
 * and `attempt_count` on the step run stops being a record of what happened.
 */
export class RetryExhaustedError extends Error {
  attemptCount: number;

  constructor(cause: unknown, attemptCount: number) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RetryExhaustedError';
    this.attemptCount = attemptCount;
    this.cause = cause;
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  { attempts = MAX_STEP_ATTEMPTS, baseDelayMs = 500 } = {},
): Promise<{ result: T; attemptCount: number }> {
  let lastError: unknown;
  let spent = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    spent = attempt;
    try {
      return { result: await operation(attempt), attemptCount: attempt };
    } catch (error) {
      lastError = error;
      if (error instanceof PermanentError || attempt === attempts) break;
      // Jitter matters once more than one run backs off against the same upstream at
      // the same moment.
      await delay(baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 150));
    }
  }

  throw new RetryExhaustedError(lastError, spent);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
