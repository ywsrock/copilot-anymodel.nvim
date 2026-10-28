// Resolves a provider's API key: its environment variable first, then the key
// file written by `:Cop key <provider>`. The file is re-read when it changes, so
// a key saved while Neovim is running takes effect on the next request.

import { readFileSync, statSync } from 'node:fs';

// Accepts a pasted shell line such as `export ANTHROPIC_API_KEY="sk-ant-..."`.
export function normalizeKey(text) {
  return text.trim()
    .replace(/^export\s+/, '')
    .replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/, '')
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

// apiKeyEnv / authTokenEnv: environment variable names for this provider.
export function createCredentials({ keyFile = null, apiKeyEnv = null, authTokenEnv = null, env = process.env } = {}) {
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
    // { apiKey } or { authToken }, or null when nothing is configured.
    resolve() {
      if (apiKeyEnv && env[apiKeyEnv]) return { apiKey: env[apiKeyEnv], source: 'env' };
      const key = fromFile();
      if (key) return { apiKey: key, source: 'file' };
      if (authTokenEnv && env[authTokenEnv]) return { authToken: env[authTokenEnv], source: 'env' };
      return null;
    },
  };
}
