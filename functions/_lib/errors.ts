import type { Response } from 'express';

export class HandlerError extends Error {
  code: string;
  status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = 'HandlerError';
    this.code = code;
    this.status = status;
  }
}

export const forbidden = (message: string) => new HandlerError(message, 'forbidden', 403);
export const conflict = (message: string) => new HandlerError(message, 'conflict', 409);

/**
 * Everything a caller is not entitled to reads as "not found", never "forbidden".
 * A forbidden response confirms the resource exists, which is the leak the row-level
 * rules avoid by returning null. Both layers should tell the same story.
 */
export const notFound = (message: string) => new HandlerError(message, 'not-found', 404);

export const quotaExhausted = () =>
  new HandlerError('Organization quota exhausted for this period', 'quota-exhausted', 402);

export function sendError(res: Response, error: unknown) {
  if (error instanceof HandlerError) {
    return res.status(error.status).json({
      message: error.message,
      extensions: { code: error.code },
    });
  }

  // Detail goes to the log, not to the client: an error message is an enumeration
  // surface when it echoes internals.
  console.error(error);
  return res.status(500).json({
    message: 'Internal error while processing the workflow',
    extensions: { code: 'internal' },
  });
}
