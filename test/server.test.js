import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../server/lib/prompt.js';
import { clean, toItem } from '../server/lib/postprocess.js';
import { createCredentials } from '../server/lib/credentials.js';

// Tests run the bundle users actually get; `npm run build` first.
const serverPath = fileURLToPath(new URL('../dist/server.mjs', import.meta.url));

function startServer(env = {}, args = []) {
  const child = spawn(process.execPath, [serverPath, ...args], {
    env: { ...process.env, CLAUDE_COMPLETE_PROVIDER: 'mock', ...env },
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
  assert.equal(clean('<completion>```js\nbar, baz\n```</completion>', ctx), 'bar, baz');
  assert.equal(clean('Looking at the code, nothing is needed.', ctx), '');
  assert.equal(clean('Sure: <completion>bar)</completion> done', ctx), 'bar)');

  const mid = buildContext({ text: 'call(a)\n', languageId: 'js', path: 'a.js' }, { line: 0, character: 6 });
  assert.equal(mid.singleLine, true);
  assert.equal(clean('<completion>, b)\nmore', mid), ', b');

  const echo = buildContext({ text: '  return \n', languageId: 'js', path: 'a.js' }, { line: 0, character: 9 });
  assert.equal(clean('<completion>return a + b</completion>', echo), 'a + b');
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
  const server = startServer({ CLAUDE_COMPLETE_MOCK_TEXT: 'world()\\nnext()' });
  t.after(() => server.close());

  const init = await server.request('initialize', { capabilities: {} }).response;
  assert.equal(init.result.serverInfo.name, 'claude-complete');
  server.notify('initialized', {});
  server.notify('workspace/didChangeConfiguration', { settings: { claude: { debounceMs: 0 } } });

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
  server.notify('workspace/didChangeConfiguration', { settings: { claude: { debounceMs: 500 } } });
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
  assert.equal(clean('<completion>value\n\n\ndef g():\n    pass</completion>', ctx), 'value');
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

  assert.equal(createCredentials({ keyFile, env: { ANTHROPIC_API_KEY: 'sk-ant-env' } }).resolve().source, 'env');
});

test('real provider without a key reports a setup hint instead of calling the API', async (t) => {
  const server = startServer({ CLAUDE_COMPLETE_PROVIDER: 'claude', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
    ['--key-file', join(tmpdir(), 'cc-missing-key')]);
  t.after(() => server.close());
  await server.request('initialize', {}).response;
  server.notify('initialized', {});
  const uri = 'file:///tmp/b.js';
  server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'javascript', version: 1, text: 'x\n' } });
  const r = await server.request('textDocument/inlineCompletion', { textDocument: { uri }, position: { line: 0, character: 1 }, context: { triggerKind: 2 } }).response;
  assert.deepEqual(r.result.items, []);
  const status = server.notifications.filter((n) => n.method === 'didChangeStatus').at(-1);
  assert.equal(status.params.kind, 'Error');
  assert.match(status.params.message, /ClaudeComplete setup/);
});
