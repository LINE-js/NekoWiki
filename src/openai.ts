import type { OpenAIConfig } from './config.js';
import { isRecord } from './guards.js';
import { isRetryableCode, retry } from './retry.js';

const API_URL = 'https://api.openai.com/v1/responses';

export class OpenAIError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string) {
    super(`OpenAI request failed: ${code}`);
    this.name = 'OpenAIError';
    this.code = code;
    this.retryable = isRetryableCode(code);
  }
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What the pipeline needs from a model: one forced tool call, returning the tool's parsed arguments. */
export interface Llm {
  callTool(system: string, tool: ToolSpec, content: string): Promise<unknown>;
  readonly usage?: { requests: number; inputTokens: number; outputTokens: number };
}

export type OpenAIFetch = (url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Minimal Responses API client (Chat Completions rejects function tools on reasoning models) that forces one strict function call and returns its parsed arguments. */
export class OpenAI implements Llm {
  readonly usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  readonly #config: OpenAIConfig;
  readonly #fetch: OpenAIFetch;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(config: OpenAIConfig, fetchImpl: OpenAIFetch = fetch, sleep?: (ms: number) => Promise<void>) {
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
  }

  callTool(system: string, tool: ToolSpec, content: string): Promise<unknown> {
    return retry(() => this.#once(system, tool, content), this.#sleep);
  }

  async #once(system: string, tool: ToolSpec, content: string): Promise<unknown> {
    const signal = AbortSignal.timeout(this.#config.timeoutMs);
    let body: unknown;
    try {
      const response = await this.#fetch(API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.#config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.#config.model,
          max_output_tokens: this.#config.maxOutputTokens,
          instructions: system,
          input: content,
          tools: [{ type: 'function', ...tool, strict: true }],
          tool_choice: { type: 'function', name: tool.name },
          parallel_tool_calls: false,
          store: false,
        }),
        signal,
      });
      if (!response.ok) throw new OpenAIError(`HTTP_${response.status}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof OpenAIError) throw error;
      throw new OpenAIError(signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED');
    }
    if (!isRecord(body)) throw new OpenAIError('INVALID_RESPONSE');
    this.usage.requests += 1;
    if (isRecord(body.usage)) {
      this.usage.inputTokens += typeof body.usage.input_tokens === 'number' ? body.usage.input_tokens : 0;
      this.usage.outputTokens += typeof body.usage.output_tokens === 'number' ? body.usage.output_tokens : 0;
    }
    if (body.status === 'incomplete') throw new OpenAIError('OUTPUT_TRUNCATED');
    const output = Array.isArray(body.output) ? body.output.filter(isRecord) : [];
    const call = output.find((item) => item.type === 'function_call' && item.name === tool.name);
    const refused = output.some((item) => item.type === 'message' && Array.isArray(item.content)
      && item.content.some((part: unknown) => isRecord(part) && part.type === 'refusal'));
    if (!call && refused) throw new OpenAIError('REFUSED');
    const args = call?.arguments;
    if (typeof args !== 'string') throw new OpenAIError('INVALID_RESPONSE');
    try {
      return JSON.parse(args);
    } catch {
      throw new OpenAIError('INVALID_RESPONSE');
    }
  }
}
