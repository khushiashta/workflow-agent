import { PermanentError } from './retry.ts';
import type { RunContext } from './types.ts';

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const ALLOWED_ROOTS = new Set(['trigger', 'steps']);

/**
 * Deliberately tiny: `trigger.*` and `steps.<order>.output.*`, nothing else. An
 * expression language here would be a code-execution surface handed to whoever can
 * author a workflow, and the cost of the restriction is a config field nobody misses.
 */
function resolvePath(path: string, context: RunContext): unknown {
  const segments = path.split('.');
  const root = segments[0];

  if (!root || !ALLOWED_ROOTS.has(root)) {
    throw new PermanentError(
      `Template "${path}" must start with "trigger" or "steps"`,
    );
  }

  let value: unknown = context;
  for (const segment of segments) {
    if (value === null || typeof value !== 'object') {
      throw new PermanentError(`Template "${path}" does not resolve`);
    }
    value = (value as Record<string, unknown>)[segment];
  }

  // An unresolved placeholder passed through as literal text turns a wiring mistake
  // into a plausible-looking wrong answer, which is far harder to notice than a failure.
  if (value === undefined) throw new PermanentError(`Template "${path}" resolved to nothing`);
  return value;
}

function resolveString(value: string, context: RunContext): unknown {
  const whole = value.match(/^\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}$/);
  // A placeholder that is the entire string keeps its type; embedded ones stringify.
  if (whole?.[1]) return resolvePath(whole[1], context);

  return value.replace(PLACEHOLDER, (_match, path: string) => {
    const resolved = resolvePath(path, context);
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}

export function resolveTemplates<T>(value: T, context: RunContext): T {
  if (typeof value === 'string') return resolveString(value, context) as T;
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, context)) as T;
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, context)]),
    ) as T;
  }
  return value;
}
