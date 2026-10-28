// Resolves the Anthropic API key: ANTHROPIC_API_KEY first, then the key file
// written by `:ClaudeComplete setup`. The file is re-read when it changes, so a
// key saved while Neovim is running takes effect on the next request.

import { readFileSync, statSync } from 'node:fs';

// Accepts a pasted shell line such as `export ANTHROPIC_API_KEY="sk-ant-..."`.
export function normalizeKey(text) {
  return text.trim()
    .replace(/^export\s+/, '')
    .replace(/^ANTHROPIC_API_KEY\s*=\s*/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

export function createCredentials({ keyFile = null, env = process.env } = {}) {
  let cache = { mtimeMs: -1, key: null };

  function fromFile() {
    if (!keyFile) return null;
    try {
      const { mtimeMs } = statSync(keyFile);
      if (mtimeMs !== cache.mtimeMs) {
        cache = { mtimeMs, key: normalizeKey(readFileSync(keyFile, 'utf8')) || null };
      }
      return cache.key;
    } catch {
      return null;
    }
  }

  return {
    // { apiKey } for the SDK, or null when nothing is configured.
    resolve() {
      if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY, source: 'env' };
      const key = fromFile();
      if (key) return { apiKey: key, source: 'file' };
      if (env.ANTHROPIC_AUTH_TOKEN) return { authToken: env.ANTHROPIC_AUTH_TOKEN, source: 'env' };
      return null;
    },
  };
}
