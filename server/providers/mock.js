// Offline provider for tests: COPILOT_ANYMODEL_MOCK_TEXT is returned as the completion.

export const models = [
  { id: 'mock', modelName: 'Mock' },
  { id: 'mock-2', modelName: 'Mock 2' },
];

export function createProvider() {
  return {
    name: 'mock',
    hasCredentials() {
      return true;
    },
    ownsModel(id) {
      return typeof id === 'string' && id.startsWith('mock');
    },
    async listModels() {
      return models;
    },
    async complete(ctx, { model, variant, signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      signal?.throwIfAborted();
      const text = (process.env.COPILOT_ANYMODEL_MOCK_TEXT ?? 'mock()').replaceAll('\\n', '\n');
      const body = variant ? `${text} // alt` : text;
      return { text: `<completion>${body}</completion>`, stats: { model, ttftMs: 20, totalMs: 20, usage: null } };
    },
  };
}
