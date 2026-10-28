// Model ids are "<provider>/<model>", e.g. "anthropic/claude-haiku-5-5".

export function parseModelId(id) {
  if (typeof id !== 'string' || !id) return null;
  const slash = id.indexOf('/');
  if (slash > 0) return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
  // Bare Claude ids from before providers were named.
  if (id.startsWith('claude-')) return { provider: 'anthropic', model: id };
  return null;
}

export function modelId(provider, model) {
  return `${provider}/${model}`;
}
