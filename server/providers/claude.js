import Anthropic from '@anthropic-ai/sdk';
import { CLOSE_TAG, SYSTEM_PROMPT, extractCompletion, instructions } from '../lib/prompt.js';

export const models = [
  { id: 'claude-haiku-5-5', modelName: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5' },
];

// How each model turns thinking off; unknown models get adaptive thinking at low effort.
const THINKING_OFF = {
  'claude-haiku-5-5': { type: 'disabled' },
  'claude-sonnet-5-5': { type: 'between_tools' },
};

export function createProvider({ credentials }) {
  // One long-lived client keeps the HTTPS connection alive between requests;
  // it is rebuilt only when the key changes.
  let client = null;
  let clientKey = null;

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

  return {
    name: 'claude',

    hasCredentials() {
      return credentials.resolve() !== null;
    },

    // Streams a completion and stops early once `maxLines` lines are produced.
    // Returns { text, stats } where stats carries latency and token usage.
    async complete(ctx, { model, maxTokens, maxLines, variant, signal }) {
      const client = getClient();
      if (!client) throw new Error('No Anthropic API key configured');
      const content = [];
      if (ctx.stable) {
        content.push({ type: 'text', text: ctx.stable, cache_control: { type: 'ephemeral' } });
      }
      content.push({ type: 'text', text: ctx.volatile });
      const extra = instructions(ctx, { variant });
      if (extra) content.push({ type: 'text', text: extra });

      const started = performance.now();
      const stats = { model, ttftMs: null, totalMs: null, usage: null };
      const stream = client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          // Latency first: no thinking tokens before the answer.
          thinking: THINKING_OFF[model] ?? { type: 'adaptive' },
          output_config: { effort: 'low' },
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
      return { text, stats };
    },
  };
}
