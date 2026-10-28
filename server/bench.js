#!/usr/bin/env node
// Measures completion latency against a real provider.
//   node server/bench.js [file] [line] [runs] [provider/model] [col|end|mid]
//   key: the provider's env var (e.g. ANTHROPIC_API_KEY), or the file saved by :Cop key

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from './lib/prompt.js';
import { clean } from './lib/postprocess.js';
import { createCredentials } from './lib/credentials.js';
import { parseModelId } from './lib/models.js';
import * as anthropic from './providers/anthropic.js';

const registry = { anthropic };
const [file = new URL('./server.js', import.meta.url).pathname, lineArg = '60', runsArg = '5', id = 'anthropic/claude-haiku-5-5', colArg = 'end'] = process.argv.slice(2);
const { provider: name, model } = parseModelId(id);
const mod = registry[name];
const text = readFileSync(file, 'utf8');
const line = Number(lineArg) - 1;
const lineText = text.split('\n')[line] ?? '';
const character = colArg === 'end' ? lineText.length : colArg === 'mid' ? Math.ceil(lineText.length / 2) : Number(colArg);
const position = { line, character };
const ctx = buildContext({ text, languageId: file.split('.').pop(), path: file }, position);
const keyDir = process.env.COPILOT_ANYMODEL_KEY_DIR ?? `${homedir()}/.local/share/nvim/copilot-anymodel/keys`;
const provider = mod.createProvider({ credentials: createCredentials({ keyFile: join(keyDir, name), ...mod.auth }), options: {} });

console.log(`${id}  ${file}:${line + 1}:${position.character}  "${ctx.prefixLine}|${ctx.suffixLine}"`);
for (let i = 0; i < Number(runsArg); i++) {
  const { text: completion, stats } = await provider.complete(ctx, { model, maxTokens: 256, maxLines: ctx.singleLine ? 1 : 8 });
  const u = stats.usage ?? {};
  console.log(`#${i + 1} ttft=${stats.ttftMs}ms total=${stats.totalMs}ms in=${u.input_tokens} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}  -> ${JSON.stringify(clean(completion, ctx))}`);
}
