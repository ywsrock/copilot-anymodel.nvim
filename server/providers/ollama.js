// Local models through Ollama. Models with the "insert" capability (most coder
// models) get a fill-in-the-middle request; others get the chat prompt.

import { CLOSE_TAG, SYSTEM_PROMPT, extractCompletion, instructions } from '../lib/prompt.js';

export const auth = null;

// Shown before Ollama answers; the real list comes from /api/tags.
export const models = [{ id: 'qwen2.5-coder:7b', modelName: 'qwen2.5-coder:7b' }];

// Local inference re-reads everything after the first changed token on each
// keystroke and generates slowly on CPU, so send less and ask for less.
export const defaults = { linesAfter: 15, maxLines: 4, maxTokens: 128, alternatives: 0 };

const LIST_TIMEOUT_MS = 3000;

function baseUrlFrom(options, env) {
  let url = options.baseUrl ?? env.OLLAMA_HOST ?? 'http://localhost:11434';
  if (!/^https?:\/\//.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

// Yields each JSON object of a newline-delimited JSON stream.
async function* ndjson(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

export function createProvider({ options = {}, env = process.env } = {}) {
  const baseUrl = baseUrlFrom(options, env);
  const keepAlive = options.keepAlive ?? '30m';
  const capabilities = new Map(); // model -> string[] (from /api/show)

  async function post(path, body, signal) {
    const res = await fetch(baseUrl + path, { method: 'POST', body: JSON.stringify(body), signal });
    if (!res.ok) {
      const err = new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function capabilitiesOf(model) {
    if (!capabilities.has(model)) {
      const res = await post('/api/show', { model }, AbortSignal.timeout(LIST_TIMEOUT_MS));
      capabilities.set(model, (await res.json()).capabilities ?? []);
    }
    return capabilities.get(model);
  }

  function request(ctx, { model, maxTokens, variant, fim }) {
    const generation = {
      num_predict: maxTokens,
      // Alternatives should differ from the first suggestion.
      temperature: variant ? 0.6 : 0,
    };
    if (fim) {
      if (ctx.singleLine) generation.stop = ['\n'];
      return ['/api/generate', { model, prompt: ctx.fimPrefix, suffix: ctx.fimSuffix, stream: true, keep_alive: keepAlive, options: generation }];
    }
    generation.stop = [CLOSE_TAG];
    const content = [ctx.stable + ctx.volatile, instructions(ctx, { variant })].filter(Boolean).join('\n\n');
    return ['/api/chat', {
      model,
      stream: true,
      keep_alive: keepAlive,
      // Reasoning models would otherwise think before answering.
      think: false,
      options: generation,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
    }];
  }

  return {
    name: 'ollama',

    // No key; an unreachable server just lists no models.
    ready() {
      return true;
    },

    async listModels() {
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const list = [];
      for (const m of (await res.json()).models ?? []) {
        const caps = await capabilitiesOf(m.name).catch(() => []);
        if (!caps.includes('completion') || caps.includes('embedding')) continue;
        const size = m.details?.parameter_size ? ` ${m.details.parameter_size}` : '';
        list.push({ id: m.name, modelName: `${m.name}${size}${caps.includes('insert') ? ' FIM' : ''}` });
      }
      return list;
    },

    // Loads the model into memory so the first completion does not wait for it.
    async warm(model) {
      await post('/api/generate', { model, keep_alive: keepAlive }, AbortSignal.timeout(120_000));
    },

    // Streams a completion; aborting the request also stops Ollama's work on it.
    async complete(ctx, { model, maxTokens, maxLines, variant, signal }) {
      const fim = (await capabilitiesOf(model).catch(() => [])).includes('insert');
      const [path, body] = request(ctx, { model, maxTokens, variant, fim });
      const started = performance.now();
      const stats = { model, ttftMs: null, totalMs: null, usage: null };
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      let raw = '';
      const visible = () => (fim ? raw : extractCompletion(raw));
      try {
        const res = await post(path, body, controller.signal);
        for await (const event of ndjson(res.body)) {
          if (event.error) throw new Error(`Ollama: ${event.error}`);
          const piece = fim ? event.response : event.message?.content;
          if (piece) {
            stats.ttftMs ??= Math.round(performance.now() - started);
            raw += piece;
            if (visible().replace(/^\n+/, '').split('\n').length > maxLines) {
              controller.abort();
              break;
            }
          }
          if (event.done) {
            stats.usage = { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count };
          }
        }
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (!controller.signal.aborted) throw err;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      stats.totalMs = Math.round(performance.now() - started);
      return { text: visible(), raw, stats };
    },
  };
}
