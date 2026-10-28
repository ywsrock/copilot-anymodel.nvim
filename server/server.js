#!/usr/bin/env node
// copilot.vim compatible language server that completes code with Claude.
//
//   let g:copilot_command = ['node', '/path/to/server.mjs', '--key-dir', '/path/to/keys']

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from './lib/lsp.js';
import { buildContext } from './lib/prompt.js';
import { clean, toItem } from './lib/postprocess.js';
import { createCredentials } from './lib/credentials.js';
import { modelId, parseModelId } from './lib/models.js';
import * as anthropic from './providers/anthropic.js';
import * as mock from './providers/mock.js';
import * as ollama from './providers/ollama.js';
import * as openai from './providers/openai.js';

const VERSION = '0.1.0';
const ACCEPT_COMMAND = { title: 'Accept', command: 'copilot-anymodel.accepted', arguments: [] };

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

// A provider module with fixed options, e.g. OpenRouter is the OpenAI module
// pointed at another URL with another key.
function preset(mod, options, auth, models = mod.models) {
  return {
    ...mod,
    auth,
    models,
    createProvider: (args) => mod.createProvider({ ...args, options: { ...options, ...args.options } }),
  };
}

const builtins = {
  anthropic,
  ollama,
  mock,
  openai: preset(openai, { api: 'responses', baseUrl: 'https://api.openai.com/v1' }, { apiKeyEnv: 'OPENAI_API_KEY' }),
  openrouter: preset(openai, { api: 'chat', baseUrl: 'https://openrouter.ai/api/v1', requiresKey: true },
    { apiKeyEnv: 'OPENROUTER_API_KEY' }, [{ id: 'openai/gpt-5.4-mini', modelName: 'openai/gpt-5.4-mini' }]),
};

// Built-in providers, plus any `providers.<name> = { type = 'openai-compatible', baseUrl = ... }`.
function registryEntry(name) {
  if (builtins[name]) return builtins[name];
  const options = config.providers?.[name];
  if (options?.type !== 'openai-compatible' || !options.baseUrl) return null;
  return preset(openai, { api: 'chat', requiresKey: false, name }, { apiKeyEnv: options.apiKeyEnv ?? null }, []);
}
const keyDir = argValue('--key-dir');
// Tests pin the provider list. Otherwise anthropic and ollama are on, plus any
// provider configured under `providers`; `providers = { ollama = false }` turns one off.
const pinned = process.env.COPILOT_ANYMODEL_PROVIDER?.split(',').filter(Boolean) ?? null;

const instances = new Map(); // name -> provider
function getProvider(name) {
  const mod = registryEntry(name);
  if (!mod) return null;
  if (!instances.has(name)) {
    const credentials = createCredentials({ keyFile: keyDir && mod.auth ? join(keyDir, name) : null, ...mod.auth });
    instances.set(name, mod.createProvider({ credentials, options: providerOptions(name) }));
  }
  return instances.get(name);
}

function providerOptions(name) {
  const options = config.providers?.[name];
  return options && typeof options === 'object' ? options : {};
}

function enabledProviders() {
  if (pinned) return pinned.filter((n) => registryEntry(n));
  const configured = Object.keys(config.providers ?? {}).filter((n) => registryEntry(n) && n !== 'mock');
  // openai and openrouter only list models once their key is set.
  return [...new Set(['anthropic', 'ollama', 'openai', 'openrouter', ...configured])].filter((n) => config.providers?.[n] !== false);
}

const TUNABLE = ['maxTokens', 'maxLines', 'debounceMs', 'linesBefore', 'linesAfter', 'alternatives'];

// Request settings for one provider: global defaults, then the provider's own
// defaults, then what the user set globally, then what they set for the provider.
function settingsFor(name) {
  const result = {};
  for (const key of TUNABLE) {
    for (const source of [defaults, registryEntry(name).defaults ?? {}, own, providerOptions(name)]) {
      if (source[key] !== undefined && source[key] !== null) result[key] = source[key];
    }
  }
  return result;
}

// The configured model, or the first enabled provider's default when its
// provider is unknown or disabled.
function currentModel() {
  const parsed = parseModelId(config.model);
  const enabled = enabledProviders();
  if (parsed && enabled.includes(parsed.provider)) return parsed;
  const name = enabled[0];
  return { provider: name, model: registryEntry(name).models[0]?.id };
}

const defaults = {
  model: 'anthropic/claude-haiku-5-5',
  providers: {},
  maxTokens: 256,
  maxLines: 8,
  debounceMs: 100,
  linesBefore: 200,
  linesAfter: 50,
  alternatives: 2,
};
let config = { ...defaults };
let own = {}; // settings exactly as the user gave them

const conn = createConnection();
const docs = new Map(); // uri -> { text, languageId, path }
let last = null; // most recent primary completion, reused while the user types into it

// ---------------------------------------------------------------- helpers

function log(message, type = 4) {
  conn.notify('window/logMessage', { type, message: `[copilot-anymodel] ${message}` });
}

function setStatus(kind, message = '') {
  conn.notify('didChangeStatus', { kind, message, busy: false });
}

function uriToPath(uri) {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
  } catch {
    return uri;
  }
}

function applySettings(settings = {}) {
  own = settings.anymodel ?? {};
  const selected = settings.github?.copilot?.selectedCompletionModel;
  const next = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (own[key] !== undefined && own[key] !== null) next[key] = own[key];
  }
  // :Copilot model may hold a GitHub model id picked while on the copilot backend.
  if (selected && parseModelId(selected)) next.model = selected;
  if (JSON.stringify(next.providers) !== JSON.stringify(config.providers)) instances.clear();
  config = next;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function offsetAt(text, { line, character }) {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', offset);
    if (nl < 0) return text.length;
    offset = nl + 1;
  }
  return Math.min(offset + character, text.length);
}

// The user kept typing exactly what was suggested: answer from the previous
// completion without calling the model.
function continuation(uri, ctx) {
  if (!last || last.uri !== uri || last.after !== ctx.after || !ctx.before.startsWith(last.before)) return null;
  const full = last.before + last.completion;
  if (!full.startsWith(ctx.before)) return null;
  const rest = full.slice(ctx.before.length);
  return rest.trim() ? rest : null;
}

async function generate(uri, ctx, { name, model, settings, variant, signal }) {
  const options = { model, maxTokens: settings.maxTokens, maxLines: ctx.singleLine ? 1 : settings.maxLines, variant, signal };
  let result;
  try {
    result = await getProvider(name).complete(ctx, options);
  } catch (err) {
    err.provider = name;
    throw err;
  }
  const { text, raw, stats } = result;
  const completion = clean(text, ctx, { maxLines: options.maxLines });
  const u = stats.usage;
  if (process.env.COPILOT_ANYMODEL_DUMP) {
    appendFileSync(process.env.COPILOT_ANYMODEL_DUMP, `===== ${ctx.path}:${ctx.row + 1}\n${ctx.stable}${ctx.volatile}\n----- raw\n${raw}\n`);
  }
  log(`${modelId(name, stats.model)}${variant ? ' (alt)' : ''} at=${ctx.row + 1}:${ctx.prefixLine.length} ttft=${stats.ttftMs}ms total=${stats.totalMs}ms` +
    (u ? ` in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}` : '') +
    ` chars=${completion.length}`);
  if (!variant && completion) last = { uri, before: ctx.before, after: ctx.after, completion };
  return completion;
}

function reportError(err) {
  if (err?.status === 401 || err?.status === 403) {
    setStatus('Error', `Authentication failed (${err.status}): run :Cop key ${err.provider ?? ''} to set a valid key`);
  } else {
    setStatus('Warning', String(err?.message ?? err));
  }
  log(`completion failed: ${err?.stack ?? err}`, 1);
}

async function complete(params, signal, { invoked }) {
  const uri = params.textDocument?.uri;
  const doc = docs.get(uri);
  if (!doc) return { items: [] };
  const { provider: name, model } = currentModel();
  if (!getProvider(name).ready()) {
    setStatus('Error', missingKey(name));
    return { items: [] };
  }
  const settings = settingsFor(name);
  const ctx = buildContext(doc, params.position, settings);

  const completions = [];
  const cached = continuation(uri, ctx);
  if (cached) completions.push(cached);

  const variants = [];
  if (!cached) variants.push(false);
  if (invoked) for (let i = 0; i < settings.alternatives; i++) variants.push(true);

  if (variants.length) {
    if (!invoked && !cached) await sleep(settings.debounceMs, signal);
    const results = await Promise.allSettled(variants.map((variant) => generate(uri, ctx, { name, model, settings, variant, signal })));
    if (signal.aborted) throw signal.reason;
    let ok = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok = true;
        if (r.value) completions.push(r.value);
      }
    }
    if (ok) setStatus('Normal');
    else reportError(results[0].reason);
  }

  const seen = new Set();
  const items = [];
  for (const completion of completions) {
    const item = { ...toItem(completion, ctx, params.position), command: ACCEPT_COMMAND };
    if (!seen.has(item.insertText)) {
      seen.add(item.insertText);
      items.push(item);
    }
  }
  return { items };
}

// ---------------------------------------------------------------- lifecycle

conn.onRequest('initialize', (params) => {
  if (params.initializationOptions?.settings) applySettings(params.initializationOptions.settings);
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: 1 },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'copilot-anymodel', version: VERSION, nodeVersion: process.versions.node },
  };
});

function missingKey(name) {
  const env = registryEntry(name)?.auth?.apiKeyEnv;
  return `No API key for ${name}. Run :Cop key ${name}${env ? ` (or set ${env})` : ''}.`;
}

// Gets the selected model ready: fetches capabilities, or loads a local model.
let warmed = null;
function warmUp() {
  const { provider: name, model } = currentModel();
  const id = modelId(name, model);
  if (warmed === id) return;
  warmed = id;
  const provider = getProvider(name);
  if (!provider.ready()) return;
  provider.listModels().catch(() => {});
  if (provider.warm) {
    const started = performance.now();
    provider.warm(model).then(
      () => log(`${id} loaded in ${Math.round(performance.now() - started)}ms`),
      (err) => log(`${id} could not be loaded: ${err?.message ?? err}`, 2),
    );
  }
}

conn.onNotification('initialized', () => {
  const { provider: name, model } = currentModel();
  const provider = getProvider(name);
  if (provider.ready()) {
    setStatus('Normal');
    warmUp();
  } else {
    setStatus('Error', missingKey(name));
  }
  log(`started: model=${modelId(name, model)} providers=${enabledProviders().join(',')}`, 3);
});

conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));

conn.onNotification('workspace/didChangeConfiguration', (params) => {
  applySettings(params.settings);
  log(`config: ${JSON.stringify(config)}`);
  warmUp();
});

// ---------------------------------------------------------------- documents

conn.onNotification('textDocument/didOpen', ({ textDocument }) => {
  docs.set(textDocument.uri, { text: textDocument.text, languageId: textDocument.languageId, path: uriToPath(textDocument.uri) });
});

conn.onNotification('textDocument/didChange', ({ textDocument, contentChanges }) => {
  const doc = docs.get(textDocument.uri);
  if (!doc) return;
  for (const change of contentChanges) {
    if (!change.range) {
      doc.text = change.text;
    } else {
      const start = offsetAt(doc.text, change.range.start);
      const end = offsetAt(doc.text, change.range.end);
      doc.text = doc.text.slice(0, start) + change.text + doc.text.slice(end);
    }
  }
});

conn.onNotification('textDocument/didClose', ({ textDocument }) => {
  docs.delete(textDocument.uri);
  if (last?.uri === textDocument.uri) last = null;
});

// ---------------------------------------------------------------- completion

conn.onRequest('textDocument/inlineCompletion', (params, signal) =>
  complete(params, signal, { invoked: params.context?.triggerKind === 1 }));

conn.onRequest('textDocument/copilotPanelCompletion', (params, signal) =>
  complete(params, signal, { invoked: true }));

// ---------------------------------------------------------------- copilot.vim compatibility

const user = 'anymodel';
conn.onRequest('signIn', () => ({ status: 'AlreadySignedIn', user }));
conn.onRequest('signInConfirm', () => ({ status: 'OK', user }));
conn.onRequest('signOut', () => ({ status: 'NotSignedIn' }));
conn.onRequest('checkStatus', () => ({ status: 'OK', user }));
conn.onRequest('getVersion', () => ({ version: VERSION, buildType: 'dev', runtimeVersion: `node/${process.versions.node}` }));
// Every model of every ready provider; a provider that fails to list is skipped.
conn.onRequest('copilot/models', async () => {
  const current = currentModel();
  const names = enabledProviders().filter((n) => getProvider(n).ready());
  const lists = await Promise.all(names.map((n) => getProvider(n).listModels().catch(() => [])));
  return names.flatMap((name, i) => lists[i].map((m) => ({
    id: modelId(name, m.id),
    modelName: m.modelName,
    modelFamily: m.id,
    provider: name,
    preview: false,
    deprecated: Boolean(m.deprecatedAt),
    current: name === current.provider && m.id === current.model,
    scopes: ['completion'],
  })));
});
// Neovim drops a null result entirely and copilot.vim then fails on the missing key.
conn.onRequest('workspace/executeCommand', () => ({}));
conn.onRequest('telemetry/exception', () => ({}));

for (const method of [
  'textDocument/didFocus',
  'textDocument/didSave',
  'textDocument/didShowCompletion',
  'textDocument/didPartiallyAcceptCompletion',
  'workspace/didChangeWorkspaceFolders',
  '$/setTrace',
]) {
  conn.onNotification(method, () => {});
}

conn.listen();
