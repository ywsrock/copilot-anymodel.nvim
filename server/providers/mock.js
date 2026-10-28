// Offline provider for tests: CLAUDE_COMPLETE_MOCK_TEXT is returned as the completion.

export const models = [{ id: 'mock', modelName: 'Mock' }];

export function createProvider() {
  return {
    name: 'mock',
    hasCredentials() {
      return true;
    },
    async complete(ctx, { model, variant, signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      signal?.throwIfAborted();
      const text = (process.env.CLAUDE_COMPLETE_MOCK_TEXT ?? 'mock()').replaceAll('\\n', '\n');
      const body = variant ? `${text} // alt` : text;
      return { text: `<completion>${body}</completion>`, stats: { model, ttftMs: 20, totalMs: 20, usage: null } };
    },
  };
}
