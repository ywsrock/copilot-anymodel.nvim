import Anthropic from '@anthropic-ai/sdk';
import { CLOSE_TAG, SYSTEM_PROMPT, extractCompletion, instructions } from '../lib/prompt.js';

// Claude through the Anthropic Messages API (chat prompt, answer in <completion> tags).

export const auth = { apiKeyEnv: 'ANTHROPIC_API_KEY', authTokenEnv: 'ANTHROPIC_AUTH_TOKEN' };

// Used until the Models API answers, and if it cannot be reached.
export const models = [
  { id: 'claude-haiku-5-5', modelName: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5' },
];

const FALLBACK_CAPABILITIES = {
  'claude-haiku-5-5': {
    thinking: { supported: true, types: { disabled: { supported: true } } },
    effort: { supported: true, low: { supported: true } },
  },
  'claude-sonnet-5-5': {
    thinking: { supported: true, types: { between_tools: { supported: true } } },
    effort: { supported: true, low: { supported: true } },
  },
};

const CATALOG_TTL_MS = 60 * 60 * 1000;
// Room for thinking on models that cannot turn it off; thinking counts toward max_tokens.
const THINKING_HEADROOM = 4096;

const supported = (node) => node?.supported === true;

// Fastest request settings a model accepts, from its Models API capabilities.
// Unknown capabilities: send neither thinking nor effort, which every model accepts.
export function speedParams(capabilities, maxTokens) {
  const types = capabilities?.thinking?.types;
  let thinking;
  if (supported(types?.disabled)) thinking = { type: 'disabled' };
  else if (supported(types?.between_tools)) thinking = { type: 'between_tools' };
  else if (supported(types?.adaptive)) thinking = { type: 'adaptive' };

  const thinkingOff = thinking?.type === 'disabled' || thinking?.type === 'between_tools';
  const params = { max_tokens: thinkingOff ? maxTokens : maxTokens + THINKING_HEADROOM };
  if (thinking) params.thinking = thinking;
  if (supported(capabilities?.effort) && supported(capabilities.effort.low)) {
    params.output_config = { effort: 'low' };
  }
  return params;
}

export function createProvider({ credentials }) {
  // One long-lived client keeps the HTTPS connection alive between requests;
  // it is rebuilt only when the key changes.
  let client = null;
  let clientKey = null;
  let catalog = null; // { key, fetchedAt, list: [{ id, modelName, capabilities, deprecatedAt }] }

  function getClient() {
    const auth = credentials.resolve();
    if (!auth) return null;
    const key = auth.apiKey ?? auth.authToken;
    if (key !== clientKey) {
      // No retries: a late completion is useless, the next keystroke asks again.
      client = new Anthropic({ apiKey: auth.apiKey ?? null, authToken: auth.authToken ?? null, maxRetries: 0, timeout: 10_000 });
      clientKey = key;
    }
    return client;
  }

  function capabilitiesOf(model) {
    return catalog?.list.find((m) => m.id === model)?.capabilities ?? FALLBACK_CAPABILITIES[model] ?? null;
  }

  // Every model the key can use, from the Models API (cached for an hour).
  async function listModels({ refresh = false } = {}) {
    const api = getClient();
    if (!api) return models;
    const fresh = catalog && catalog.key === clientKey && Date.now() - catalog.fetchedAt < CATALOG_TTL_MS;
    if (fresh && !refresh) return catalog.list;
    try {
      const list = [];
      for await (const m of api.models.list()) {
        list.push({ id: m.id, modelName: m.display_name, capabilities: m.capabilities ?? null, deprecatedAt: m.deprecated_at ?? null });
      }
      catalog = { key: clientKey, fetchedAt: Date.now(), list };
      return list;
    } catch {
      return catalog?.list ?? models;
    }
  }

  return {
    name: 'anthropic',

    ready() {
      return credentials.resolve() !== null;
    },

    listModels,

    // Streams a completion and stops early once `maxLines` lines are produced.
    // Returns { text, raw, stats }: text is the completion without the tags.
    async complete(ctx, { model, maxTokens, maxLines, variant, signal }) {
      const api = getClient();
      if (!api) throw new Error('No Anthropic API key configured');
      // A model picked from the list but not yet in the catalog: learn its capabilities first.
      if (!capabilitiesOf(model)) await listModels();
      const content = [];
      if (ctx.stable) {
        content.push({ type: 'text', text: ctx.stable, cache_control: { type: 'ephemeral' } });
      }
      content.push({ type: 'text', text: ctx.volatile });
      const extra = instructions(ctx, { variant });
      if (extra) content.push({ type: 'text', text: extra });

      const started = performance.now();
      const stats = { model, ttftMs: null, totalMs: null, usage: null };
      const stream = api.messages.stream(
        {
          model,
          ...speedParams(capabilitiesOf(model), maxTokens),
          stop_sequences: [CLOSE_TAG],
          system: [{ type: 'text', text: SYSTEM_PROMPT }],
          messages: [{ role: 'user', content }],
        },
        { signal },
      );

      let text = '';
      let stoppedEarly = false;
      try {
        for await (const event of stream) {
          if (event.type === 'message_start') {
            stats.usage = event.message.usage;
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            stats.ttftMs ??= Math.round(performance.now() - started);
            text += event.delta.text;
            if (extractCompletion(text).split('\n').length > maxLines) {
              stoppedEarly = true;
              stream.abort();
              break;
            }
          }
        }
      } catch (err) {
        if (!(stoppedEarly && err instanceof Anthropic.APIUserAbortError)) throw err;
      }
      stats.totalMs = Math.round(performance.now() - started);
      return { text: extractCompletion(text), raw: text, stats };
    },
  };
}
