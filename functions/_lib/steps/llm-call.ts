import { z } from 'zod';
import { classifyHttpFailure, TransientError } from '../retry.ts';
import { resolveTemplates } from '../template.ts';
import type { StepExecutor } from '../types.ts';

const configSchema = z.object({
  prompt: z.string().min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(4096).optional(),
  timeout_ms: z.number().int().positive().max(60_000).optional(),
});

const STUB_DELAY_MS = 1000;

/**
 * The stub exists so the project runs without a key, but it announces itself: an
 * output indistinguishable from a real call is a trap for whoever debugs this next.
 */
function stubbedCompletion(prompt: string) {
  const urgent = /\b(urgent|broken|down|outage|losing|critical|asap|immediately)\b/i.test(prompt);
  return {
    text: urgent ? 'URGENT' : 'NORMAL',
    model: 'stub',
    stubbed: true,
    usage: null,
  };
}

export const executeLlmCall: StepExecutor = async ({ step, context }) => {
  const config = configSchema.parse(step.config);
  const prompt = resolveTemplates(config.prompt, context);

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    await new Promise((resolve) => setTimeout(resolve, STUB_DELAY_MS));
    return { output: stubbedCompletion(prompt) };
  }

  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.groq.com/openai/v1';
  const model = config.model ?? process.env.LLM_MODEL ?? 'llama-3.3-70b-versatile';

  let response: globalThis.Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: config.temperature ?? 0.2,
        max_tokens: config.max_tokens ?? 512,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(config.timeout_ms ?? 30_000),
    });
  } catch (error) {
    // Network failures and timeouts are retryable by definition.
    throw new TransientError(`LLM request failed: ${(error as Error).message}`);
  }

  if (!response.ok) throw classifyHttpFailure(response.status, await response.text());

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: unknown;
  };

  const text = body.choices?.at(0)?.message?.content?.trim();
  if (!text) throw new TransientError('LLM returned an empty completion');

  return { output: { text, model: body.model ?? model, stubbed: false, usage: body.usage ?? null } };
};
