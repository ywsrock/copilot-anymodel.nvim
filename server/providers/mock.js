// Offline provider for tests: COPILOT_ANYMODEL_MOCK_TEXT is returned as the completion.

export const auth = null;

export const models = [
  { id: 'fast', modelName: 'Mock Fast' },
  { id: 'alt', modelName: 'Mock Alt' },
];

export function createProvider() {
  return {
    name: 'mock',
    ready() {
      return true;
    },
    async listModels() {
      return models;
    },
    async complete(ctx, { model, variant, signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      signal?.throwIfAborted();
      const text = (process.env.COPILOT_ANYMODEL_MOCK_TEXT ?? 'mock()').replaceAll('\\n', '\n');
      const body = variant ? `${text} // alt` : text;
      return { text: body, raw: body, stats: { model, ttftMs: 20, totalMs: 20, usage: null } };
    },
  };
}
