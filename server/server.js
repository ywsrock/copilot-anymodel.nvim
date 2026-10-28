#!/usr/bin/env node
// copilot.vim compatible language server that completes code with Claude.
//
//   let g:copilot_command = ['node', '/path/to/server.mjs', '--key-file', '/path/to/api_key']

import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConnection } from './lib/lsp.js';
import { buildContext } from './lib/prompt.js';
import { clean, toItem } from './lib/postprocess.js';
import { createCredentials } from './lib/credentials.js';
import * as claude from './providers/claude.js';
import * as mock from './providers/mock.js';

const VERSION = '0.1.0';
const ACCEPT_COMMAND = { title: 'Accept', command: 'copilot-anymodel.accepted', arguments: [] };

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

const providers = { claude, mock };
const providerName = process.env.COPILOT_ANYMODEL_PROVIDER ?? 'claude';
const providerModule = providers[providerName];
if (!providerModule) throw new Error(`unknown provider: ${providerName}`);
const provider = providerModule.createProvider({ credentials: createCredentials({ keyFile: argValue('--key-file') }) });

const defaults = {
  model: providerModule.models[0].id,
  maxTokens: 256,
  maxLines: 8,
  debounceMs: 100,
  linesBefore: 200,
  linesAfter: 50,
  alternatives: 2,
};
let config = { ...defaults };

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
  const own = settings.anymodel ?? {};
  const selected = settings.github?.copilot?.selectedCompletionModel;
  const next = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (own[key] !== undefined && own[key] !== null) next[key] = own[key];
  }
  // :Copilot model may hold a GitHub model id picked while on the copilot backend.
  if (selected && provider.ownsModel(selected)) next.model = selected;
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

async function generate(uri, ctx, { variant, signal }) {
  const options = { model: config.model, maxTokens: config.maxTokens, maxLines: ctx.singleLine ? 1 : config.maxLines, variant, signal };
  const { text, stats } = await provider.complete(ctx, options);
  const completion = clean(text, ctx, { maxLines: options.maxLines });
  const u = stats.usage;
  if (process.env.COPILOT_ANYMODEL_DUMP) {
    appendFileSync(process.env.COPILOT_ANYMODEL_DUMP, `===== ${ctx.path}:${ctx.row + 1}\n${ctx.stable}${ctx.volatile}\n----- raw\n${text}\n`);
  }
  log(`${stats.model}${variant ? ' (alt)' : ''} at=${ctx.row + 1}:${ctx.prefixLine.length} ttft=${stats.ttftMs}ms total=${stats.totalMs}ms` +
    (u ? ` in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}` : '') +
    ` chars=${completion.length}`);
  if (!variant && completion) last = { uri, before: ctx.before, after: ctx.after, completion };
  return completion;
}

function reportError(err) {
  if (err?.status === 401 || err?.status === 403) {
    setStatus('Error', `Authentication failed (${err.status}): run :Cop key to set a valid key`);
  } else {
    setStatus('Warning', String(err?.message ?? err));
  }
  log(`completion failed: ${err?.stack ?? err}`, 1);
}

async function complete(params, signal, { invoked }) {
  const uri = params.textDocument?.uri;
  const doc = docs.get(uri);
  if (!doc) return { items: [] };
  if (!provider.hasCredentials()) {
    setStatus('Error', MISSING_KEY);
    return { items: [] };
  }
  const ctx = buildContext(doc, params.position, config);

  const completions = [];
  const cached = continuation(uri, ctx);
  if (cached) completions.push(cached);

  const variants = [];
  if (!cached) variants.push(false);
  if (invoked) for (let i = 0; i < config.alternatives; i++) variants.push(true);

  if (variants.length) {
    if (!invoked && !cached) await sleep(config.debounceMs, signal);
    const results = await Promise.allSettled(variants.map((variant) => generate(uri, ctx, { variant, signal })));
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

const MISSING_KEY = 'No Anthropic API key. Run :Cop key (or set ANTHROPIC_API_KEY).';

conn.onNotification('initialized', () => {
  if (provider.hasCredentials()) {
    setStatus('Normal');
    provider.listModels().catch(() => {});
  } else {
    setStatus('Error', MISSING_KEY);
  }
  log(`started: provider=${provider.name} model=${config.model}`, 3);
});

conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));

conn.onNotification('workspace/didChangeConfiguration', (params) => {
  applySettings(params.settings);
  log(`config: ${JSON.stringify(config)}`);
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

const user = `${provider.name}`;
conn.onRequest('signIn', () => ({ status: 'AlreadySignedIn', user }));
conn.onRequest('signInConfirm', () => ({ status: 'OK', user }));
conn.onRequest('signOut', () => ({ status: 'NotSignedIn' }));
conn.onRequest('checkStatus', () => ({ status: 'OK', user }));
conn.onRequest('getVersion', () => ({ version: VERSION, buildType: 'dev', runtimeVersion: `node/${process.versions.node}` }));
conn.onRequest('copilot/models', async () => {
  const list = await provider.listModels();
  return list.map((m) => ({
    id: m.id,
    modelName: m.modelName,
    modelFamily: m.id,
    preview: false,
    deprecated: Boolean(m.deprecatedAt),
    current: m.id === config.model,
    scopes: ['completion'],
  }));
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
