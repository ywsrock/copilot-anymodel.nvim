import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext, extractCompletion } from '../server/lib/prompt.js';
import { parseModelId } from '../server/lib/models.js';
import { clean, toItem } from '../server/lib/postprocess.js';
import { createCredentials, normalizeKey } from '../server/lib/credentials.js';
import { speedParams } from '../server/providers/anthropic.js';
import { createServer } from 'node:http';

// Tests run the bundle users actually get; `npm run build` first.
const serverPath = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));

function startServer(env = {}, args = []) {
  const child = spawn(process.execPath, [serverPath, ...args], {
    env: { ...process.env, COPILOT_ANYMODEL_PROVIDER: 'mock', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const waiting = new Map();
  const notifications = [];
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      } else {
        notifications.push(msg);
      }
    }
  });
  const write = (msg) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...msg });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return {
    notifications,
    request(method, params) {
      const id = nextId++;
      write({ id, method, params });
      return { id, response: new Promise((resolve) => waiting.set(id, resolve)) };
    },
    notify(method, params) {
      write({ method, params });
    },
    close() {
      child.kill();
    },
  };
}

test('clean strips fences, echoes and suffix overlap', () => {
  const doc = { text: 'const x = foo(\n', languageId: 'javascript', path: 'a.js' };
  const ctx = buildContext(doc, { line: 0, character: 14 });
  assert.equal(clean('```js\nbar, baz\n```', ctx), 'bar, baz');
  assert.equal(extractCompletion('Looking at the code, nothing is needed.'), '');
  assert.equal(extractCompletion('Sure: <completion>bar)</completion> done'), 'bar)');

  const mid = buildContext({ text: 'call(a)\n', languageId: 'js', path: 'a.js' }, { line: 0, character: 6 });
  assert.equal(mid.singleLine, true);
  assert.equal(clean(', b)\nmore', mid), ', b');

  const echo = buildContext({ text: '  return \n', languageId: 'js', path: 'a.js' }, { line: 0, character: 9 });
  assert.equal(clean('return a + b', echo), 'a + b');
});

test('toItem starts at column 0 and keeps model indentation on blank lines', () => {
  const ctx = buildContext({ text: '    \n', languageId: 'py', path: 'a.py' }, { line: 0, character: 4 });
  assert.equal(toItem('    pass', ctx, { line: 0, character: 4 }).insertText, '    pass');
  const ctx2 = buildContext({ text: 'x = \n', languageId: 'py', path: 'a.py' }, { line: 0, character: 4 });
  const item = toItem('1', ctx2, { line: 0, character: 4 });
  assert.equal(item.insertText, 'x = 1');
  assert.deepEqual(item.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } });
});

test('stable prompt part does not change while typing within a chunk', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const a = buildContext({ text, languageId: 'txt', path: 'a' }, { line: 70, character: 2 });
  const b = buildContext({ text: text.replace('line 70', 'line 70 typed'), languageId: 'txt', path: 'a' }, { line: 70, character: 10 });
  assert.ok(a.stable.length > 0);
  assert.equal(a.stable, b.stable);
  assert.notEqual(a.volatile, b.volatile);
});

test('LSP round trip: inline completion, continuation cache, cancel, compat methods', async (t) => {
  const server = startServer({ COPILOT_ANYMODEL_MOCK_TEXT: 'world()\\nnext()' });
  t.after(() => server.close());

  const init = await server.request('initialize', { capabilities: {} }).response;
  assert.equal(init.result.serverInfo.name, 'copilot-anymodel');
  server.notify('initialized', {});
  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { debounceMs: 0 } } });

  const uri = 'file:///tmp/a.js';
  server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'hello \n' } });

  const first = await server.request('textDocument/inlineCompletion', {
    textDocument: { uri }, position: { line: 0, character: 6 }, context: { triggerKind: 2 },
  }).response;
  assert.equal(first.result.items[0].insertText, 'hello world()\nnext()');
  assert.ok(first.result.items[0].command);

  // Typing "wor" matches the suggestion: served from cache.
  server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'hello wor\n' }] });
  const cont = await server.request('textDocument/inlineCompletion', {
    textDocument: { uri }, position: { line: 0, character: 9 }, context: { triggerKind: 2 },
  }).response;
  assert.equal(cont.result.items[0].insertText, 'hello world()\nnext()');

  // Cycling returns alternatives too.
  const cycle = await server.request('textDocument/inlineCompletion', {
    textDocument: { uri }, position: { line: 0, character: 9 }, context: { triggerKind: 1 },
  }).response;
  assert.ok(cycle.result.items.length >= 2);

  // Cancel during debounce.
  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { debounceMs: 500 } } });
  server.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'other \n' }] });
  const pending = server.request('textDocument/inlineCompletion', {
    textDocument: { uri }, position: { line: 0, character: 6 }, context: { triggerKind: 2 },
  });
  server.notify('$/cancelRequest', { id: pending.id });
  assert.equal((await pending.response).error.code, -32800);

  assert.equal((await server.request('signIn', {}).response).result.status, 'AlreadySignedIn');
  const models = (await server.request('copilot/models', {}).response).result;
  assert.deepEqual(models[0].scopes, ['completion']);
  assert.ok(server.notifications.some((n) => n.method === 'didChangeStatus' && n.params.kind === 'Normal'));
});

test('clean cuts the completion where it reaches existing code', () => {
  const text = 'def f(x):\n    return x.\n\ndef g():\n    pass\n';
  const ctx = buildContext({ text, languageId: 'python', path: 'a.py' }, { line: 1, character: 13 });
  assert.equal(clean('value\n\n\ndef g():\n    pass', ctx), 'value');
});

test('credentials: env wins, key file is re-read when it changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-'));
  const keyFile = join(dir, 'api_key');
  assert.equal(createCredentials({ keyFile, env: {} }).resolve(), null);

  const creds = createCredentials({ keyFile, env: {} });
  writeFileSync(keyFile, 'sk-ant-first\n');
  assert.deepEqual(creds.resolve(), { apiKey: 'sk-ant-first', source: 'file' });
  writeFileSync(keyFile, 'sk-ant-second\n');
  const later = Date.now() / 1000 + 5;
  utimesSync(keyFile, later, later);
  assert.equal(creds.resolve().apiKey, 'sk-ant-second');

  const env = { ANTHROPIC_API_KEY: 'sk-ant-env' };
  assert.equal(createCredentials({ keyFile, apiKeyEnv: 'ANTHROPIC_API_KEY', env }).resolve().source, 'env');
  // Another provider's variable is not picked up.
  assert.equal(createCredentials({ keyFile, apiKeyEnv: 'OPENAI_API_KEY', env }).resolve().source, 'file');
});

test('real provider without a key reports a setup hint instead of calling the API', async (t) => {
  const server = startServer({ COPILOT_ANYMODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    ['--key-dir', join(tmpdir(), 'cc-missing-keys')]);
  t.after(() => server.close());
  await server.request('initialize', {}).response;
  server.notify('initialized', {});
  const uri = 'file:///tmp/b.js';
  server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'x\n' } });
  const r = await server.request('textDocument/inlineCompletion', { textDocument: { uri }, position: { line: 0, character: 1 }, context: { triggerKind: 2 } }).response;
  assert.deepEqual(r.result.items, []);
  const status = server.notifications.filter((n) => n.method === 'didChangeStatus').at(-1);
  assert.equal(status.params.kind, 'Error');
  assert.match(status.params.message, /Cop key anthropic/);
});

test('normalizeKey accepts a pasted shell line', () => {
  assert.equal(normalizeKey('sk-ant-abc\n'), 'sk-ant-abc');
  assert.equal(normalizeKey('export ANTHROPIC_API_KEY=sk-ant-abc'), 'sk-ant-abc');
  assert.equal(normalizeKey('ANTHROPIC_API_KEY="sk-ant-abc"'), 'sk-ant-abc');
  assert.equal(normalizeKey("  export ANTHROPIC_API_KEY = 'sk-ant-abc'  "), 'sk-ant-abc');
});

test('copilot/models lists every model and follows the selected one', async (t) => {
  const server = startServer({ COPILOT_ANYMODEL_MOCK_TEXT: 'x' });
  t.after(() => server.close());
  await server.request('initialize', {}).response;
  server.notify('initialized', {});
  const ids = async () => (await server.request('copilot/models', {}).response).result;
  let models = await ids();
  assert.deepEqual(models.map((m) => m.id), ['mock/fast', 'mock/alt']);
  assert.equal(models[0].provider, 'mock');
  // The default model belongs to a provider that is not enabled: fall back to mock's first.
  assert.deepEqual(models.filter((m) => m.current).map((m) => m.id), ['mock/fast']);

  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { model: 'mock/alt' } } });
  models = await ids();
  assert.deepEqual(models.filter((m) => m.current).map((m) => m.id), ['mock/alt']);

  // A GitHub model id left in g:copilot_settings is ignored.
  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { model: 'mock/alt' }, github: { copilot: { selectedCompletionModel: 'gpt-4o-copilot' } } } });
  models = await ids();
  assert.deepEqual(models.filter((m) => m.current).map((m) => m.id), ['mock/alt']);
});

test('speedParams picks the fastest settings each model accepts', () => {
  const caps = (thinking, effort = ['low']) => ({
    thinking: { supported: true, types: Object.fromEntries(thinking.map((k) => [k, { supported: true }])) },
    effort: { supported: effort.length > 0, ...Object.fromEntries(effort.map((k) => [k, { supported: true }])) },
  });
  assert.deepEqual(speedParams(caps(['adaptive', 'disabled']), 256), { max_tokens: 256, thinking: { type: 'disabled' }, output_config: { effort: 'low' } });
  assert.deepEqual(speedParams(caps(['adaptive', 'between_tools']), 256), { max_tokens: 256, thinking: { type: 'between_tools' }, output_config: { effort: 'low' } });
  // Thinking cannot be turned off: leave room for it, keep effort low.
  assert.deepEqual(speedParams(caps(['adaptive']), 256), { max_tokens: 256 + 4096, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
  // Older model without effort support.
  assert.deepEqual(speedParams(caps(['enabled', 'disabled'], []), 256), { max_tokens: 256, thinking: { type: 'disabled' } });
  // Unknown model: the API default may think, so keep the headroom.
  assert.deepEqual(speedParams(null, 256), { max_tokens: 256 + 4096 });
});

test('parseModelId splits provider and model', () => {
  assert.deepEqual(parseModelId('anthropic/claude-haiku-5-5'), { provider: 'anthropic', model: 'claude-haiku-5-5' });
  assert.deepEqual(parseModelId('ollama/qwen2.5-coder:7b'), { provider: 'ollama', model: 'qwen2.5-coder:7b' });
  assert.deepEqual(parseModelId('openrouter/meta/llama'), { provider: 'openrouter', model: 'meta/llama' });
  assert.deepEqual(parseModelId('claude-sonnet-5-5'), { provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.equal(parseModelId('gpt-4o-copilot'), null);
});

// A stand-in for Ollama: two models with different capabilities, NDJSON streaming.
async function fakeOllama(t) {
  const requests = [];
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ path: req.url, body: json, closed: false });
      const entry = requests.at(-1);
      res.on('close', () => { entry.closed = true; });
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'coder:7b', details: { parameter_size: '7B' } }, { name: 'chat:1b' }, { name: 'embed' }] }));
      } else if (req.url === '/api/show') {
        const caps = { 'coder:7b': ['completion', 'insert'], 'chat:1b': ['completion'], embed: ['embedding'] }[json.model];
        res.end(JSON.stringify({ capabilities: caps }));
      } else if (req.url === '/api/generate' && json.prompt === undefined) {
        res.end(JSON.stringify({ done: true })); // warm-up
      } else if (json.model === 'slow:1b' || json.prompt?.includes('SLOW')) {
        res.write(JSON.stringify({ response: 'x' }) + '\n'); // never finishes
      } else if (req.url === '/api/generate') {
        for (const piece of ['a + ', 'b;\n', '}']) res.write(JSON.stringify({ response: piece }) + '\n');
        res.end(JSON.stringify({ done: true, prompt_eval_count: 12, eval_count: 3 }) + '\n');
      } else if (req.url === '/api/chat') {
        res.write(JSON.stringify({ message: { content: 'Here: <completion>a - b;' } }) + '\n');
        res.end(JSON.stringify({ message: { content: '' }, done: true }) + '\n');
      }
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => http.close());
  return { host: `127.0.0.1:${http.address().port}`, requests };
}

test('ollama: FIM for insert-capable models, chat otherwise, per-provider defaults', async (t) => {
  const fake = await fakeOllama(t);
  const server = startServer({ COPILOT_ANYMODEL_PROVIDER: 'ollama', OLLAMA_HOST: fake.host });
  t.after(() => server.close());
  await server.request('initialize', {}).response;
  server.notify('initialized', {});
  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { model: 'ollama/coder:7b', debounceMs: 0 } } });

  const models = (await server.request('copilot/models', {}).response).result;
  assert.deepEqual(models.map((m) => m.id), ['ollama/coder:7b', 'ollama/chat:1b']);
  assert.equal(models[0].modelName, 'coder:7b 7B FIM');
  assert.ok(fake.requests.some((r) => r.path === '/api/generate' && r.body.prompt === undefined && r.body.model === 'coder:7b'), 'warm-up');

  const uri = 'file:///tmp/add.js';
  const text = 'function add(a, b) {\n  return \n}\n';
  server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text } });
  const position = { line: 1, character: 9 };
  let r = await server.request('textDocument/inlineCompletion', { textDocument: { uri }, position, context: { triggerKind: 1 } }).response;
  assert.equal(r.result.items[0].insertText, '  return a + b;');
  const fim = fake.requests.find((x) => x.path === '/api/generate' && x.body.prompt !== undefined);
  assert.equal(fim.body.prompt, 'function add(a, b) {\n  return ');
  assert.equal(fim.body.suffix, '\n}\n');
  assert.equal(fim.body.options.num_predict, 128); // ollama default, not the global 256
  // alternatives = 0 for ollama: an explicit request (triggerKind 1) still sends one request.
  assert.equal(fake.requests.filter((x) => x.path === '/api/generate' && x.body.prompt !== undefined).length, 1);

  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { model: 'ollama/chat:1b', debounceMs: 0, providers: { ollama: { maxTokens: 64 } } } } });
  server.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'function sub(a, b) {\n  return \n}\n' }] });
  r = await server.request('textDocument/inlineCompletion', { textDocument: { uri }, position, context: { triggerKind: 2 } }).response;
  assert.equal(r.result.items[0].insertText, '  return a - b;');
  const chat = fake.requests.find((x) => x.path === '/api/chat');
  assert.equal(chat.body.options.num_predict, 64);
  assert.equal(chat.body.messages[0].role, 'system');
});

test('ollama: cancelling a completion closes the request to Ollama', async (t) => {
  const fake = await fakeOllama(t);
  const server = startServer({ COPILOT_ANYMODEL_PROVIDER: 'ollama', OLLAMA_HOST: fake.host });
  t.after(() => server.close());
  await server.request('initialize', {}).response;
  server.notify('initialized', {});
  server.notify('workspace/didChangeConfiguration', { settings: { anymodel: { model: 'ollama/coder:7b', debounceMs: 0 } } });
  const uri = 'file:///tmp/slow.js';
  server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'SLOW \n' } });
  const pending = server.request('textDocument/inlineCompletion', { textDocument: { uri }, position: { line: 0, character: 5 }, context: { triggerKind: 2 } });
  const started = Date.now();
  while (!fake.requests.some((x) => x.body.prompt?.includes('SLOW')) && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
  server.notify('$/cancelRequest', { id: pending.id });
  assert.equal((await pending.response).error.code, -32800);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fake.requests.find((x) => x.body.prompt?.includes('SLOW')).closed, true);
});
