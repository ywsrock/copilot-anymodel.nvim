// OpenAI's Responses API (api: 'responses', needed for the Codex models), or any
// OpenAI-compatible Chat Completions server (api: 'chat': OpenRouter, LM Studio,
// vLLM, Ollama's /v1, ...). Both use the chat prompt with <completion> tags.

import { CLOSE_TAG, SYSTEM_PROMPT, extractCompletion, instructions } from '../lib/prompt.js';

export const auth = { apiKeyEnv: 'OPENAI_API_KEY' };

export const models = [{ id: 'gpt-5.4-mini', modelName: 'gpt-5.4-mini' }];

const LIST_TIMEOUT_MS = 5000;
// Lowest reasoning effort first; models reject the ones they do not support.
const EFFORTS = ['none', 'minimal', 'low'];
// Room for reasoning tokens, which count toward max_output_tokens.
const REASONING_HEADROOM = 2048;

// OpenAI's list also has embedding, audio, image and moderation models.
const OPENAI_TEXT = /^(gpt-|o\d|codex|chatgpt)/;
const OPENAI_NOT_TEXT = /(audio|realtime|tts|transcribe|image|search|embedding|moderation|dall-e|whisper|instruct)/;

// Yields the parsed `data:` payload of each server-sent event.
async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data);
    }
  }
}

export function createProvider({ credentials, options = {} } = {}) {
  const api = options.api ?? 'responses';
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const requiresKey = options.requiresKey ?? api === 'responses';
  const effortFor = new Map(); // model -> index into EFFORTS, or EFFORTS.length for "send none"

  function headers() {
    const auth = credentials?.resolve();
    const h = { 'content-type': 'application/json' };
    if (auth) h.authorization = `Bearer ${auth.apiKey ?? auth.authToken}`;
    return h;
  }

  async function call(path, init) {
    const res = await fetch(baseUrl + path, { ...init, headers: { ...headers(), ...init?.headers } });
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).error?.message ?? text;
      } catch {}
      const err = new Error(`${res.status} ${String(message).slice(0, 300)}`);
      err.status = res.status;
      err.apiMessage = String(message);
      throw err;
    }
    return res;
  }

  function prompt(ctx, variant) {
    return [ctx.stable + ctx.volatile, instructions(ctx, { variant })].filter(Boolean).join('\n\n');
  }

  function responsesBody(ctx, { model, maxTokens, variant }) {
    const level = effortFor.get(model) ?? 0;
    const effort = EFFORTS[level];
    const body = {
      model,
      instructions: SYSTEM_PROMPT,
      input: prompt(ctx, variant),
      stream: true,
      store: false,
      max_output_tokens: effort && effort !== 'none' ? maxTokens + REASONING_HEADROOM : maxTokens,
    };
    if (effort) body.reasoning = { effort };
    return body;
  }

  function chatBody(ctx, { model, maxTokens, variant }) {
    return {
      model,
      stream: true,
      max_tokens: maxTokens,
      temperature: variant ? 0.6 : 0,
      stop: [CLOSE_TAG],
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt(ctx, variant) }],
    };
  }

  // Text pieces and usage from either API's stream.
  function readEvent(event, stats) {
    if (api === 'responses') {
      if (event.type === 'response.output_text.delta') return event.delta;
      if (event.type === 'response.completed') {
        const u = event.response?.usage;
        if (u) stats.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.input_tokens_details?.cached_tokens };
      }
      if (event.type === 'error' || event.type === 'response.failed') {
        throw new Error(event.message ?? event.response?.error?.message ?? 'OpenAI stream failed');
      }
      return '';
    }
    if (event.usage) stats.usage = { input_tokens: event.usage.prompt_tokens, output_tokens: event.usage.completion_tokens };
    return event.choices?.[0]?.delta?.content ?? '';
  }

  async function stream(ctx, opts, signal) {
    for (;;) {
      const body = api === 'responses' ? responsesBody(ctx, opts) : chatBody(ctx, opts);
      const path = api === 'responses' ? '/responses' : '/chat/completions';
      try {
        return await call(path, { method: 'POST', body: JSON.stringify(body), signal });
      } catch (err) {
        // The model does not take this reasoning effort (or reasoning at all): try the next.
        const level = effortFor.get(opts.model) ?? 0;
        if (api === 'responses' && err.status === 400 && /reasoning|effort/i.test(err.apiMessage ?? '') && level < EFFORTS.length) {
          effortFor.set(opts.model, level + 1);
          continue;
        }
        throw err;
      }
    }
  }

  return {
    name: options.name ?? 'openai',

    ready() {
      return !requiresKey || credentials?.resolve() != null;
    },

    async listModels() {
      const res = await call('/models', { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      const data = (await res.json()).data ?? [];
      return data
        .map((m) => m.id)
        .filter((id) => api !== 'responses' || (OPENAI_TEXT.test(id) && !OPENAI_NOT_TEXT.test(id)))
        .sort()
        .map((id) => ({ id, modelName: id }));
    },

    // Streams a completion and stops once the closing tag or `maxLines` is reached.
    async complete(ctx, { model, maxTokens, maxLines, variant, signal }) {
      const started = performance.now();
      const stats = { model, ttftMs: null, totalMs: null, usage: null };
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      let raw = '';
      try {
        const res = await stream(ctx, { model, maxTokens, variant }, controller.signal);
        for await (const event of sse(res.body)) {
          const piece = readEvent(event, stats);
          if (!piece) continue;
          stats.ttftMs ??= Math.round(performance.now() - started);
          raw += piece;
          // The Responses API has no stop sequences: stop reading at the closing tag.
          if (raw.includes(CLOSE_TAG) || extractCompletion(raw).split('\n').length > maxLines) {
            controller.abort();
            break;
          }
        }
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (!controller.signal.aborted) throw err;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      stats.totalMs = Math.round(performance.now() - started);
      return { text: extractCompletion(raw), raw, stats };
    },
  };
}
