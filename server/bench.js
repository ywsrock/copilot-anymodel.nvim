#!/usr/bin/env node
// Measures completion latency against the real provider.
//   node server/bench.js [file] [line] [runs] [model] [col|end|mid]
//   key: ANTHROPIC_API_KEY, or the file saved by :ClaudeComplete setup

import { readFileSync } from 'node:fs';
import { buildContext } from './lib/prompt.js';
import { clean } from './lib/postprocess.js';
import { homedir } from 'node:os';
import { createCredentials } from './lib/credentials.js';
import { createProvider, models } from './providers/claude.js';

const [file = new URL('./server.js', import.meta.url).pathname, lineArg = '60', runsArg = '5', model = models[0].id, colArg = 'end'] = process.argv.slice(2);
const text = readFileSync(file, 'utf8');
const line = Number(lineArg) - 1;
const lineText = text.split('\n')[line] ?? '';
const character = colArg === 'end' ? lineText.length : colArg === 'mid' ? Math.ceil(lineText.length / 2) : Number(colArg);
const position = { line, character };
const ctx = buildContext({ text, languageId: file.split('.').pop(), path: file }, position);
const keyFile = process.env.CLAUDE_COMPLETE_KEY_FILE ?? `${homedir()}/.local/share/nvim/claude-complete/api_key`;
const provider = createProvider({ credentials: createCredentials({ keyFile }) });

console.log(`${model}  ${file}:${line + 1}:${position.character}  "${ctx.prefixLine}|${ctx.suffixLine}"`);
for (let i = 0; i < Number(runsArg); i++) {
  const { text: raw, stats } = await provider.complete(ctx, { model, maxTokens: 256, maxLines: ctx.singleLine ? 1 : 8 });
  const u = stats.usage ?? {};
  console.log(`#${i + 1} ttft=${stats.ttftMs}ms total=${stats.totalMs}ms in=${u.input_tokens} ` +
    `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0}  -> ${JSON.stringify(clean(raw, ctx))}`);
}
