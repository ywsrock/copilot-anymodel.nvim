# copilot-anymodel.nvim

Keep the [copilot.vim](https://github.com/github/copilot.vim) interface, pick
the model behind it: Claude, OpenAI (including Codex), OpenRouter, local models
through Ollama, or any OpenAI-compatible server.

copilot.vim keeps doing what it does well (ghost text, `<Tab>` to accept,
cycling, the panel). This plugin swaps the language server behind it for one
that asks the model you choose.

- **Same keys, same UI**: nothing to relearn if you use copilot.vim today
- **Any model, one list**: `:Cop model` shows every model of every provider
  you have set up, fetched live; the choice is kept across sessions
- **Back to GitHub Copilot in one key**: `:Cop toggle`
- **Tuned for latency per model**: thinking/reasoning off where the model
  allows it, prompt caching, streaming with early cut-off, fill-in-the-middle
  for local coder models
- **No `npm install`**: the server ships as one bundled file

> Not affiliated with GitHub, Anthropic, OpenAI or Ollama. "GitHub Copilot" is
> a trademark of GitHub, Inc. You use your own API keys and pay each provider
> directly.

[日本語](README.ja.md)

## Requirements

- Neovim 0.10+ (tested on 0.12)
- Node.js 20+ (copilot.vim needs it too)
- [copilot.vim](https://github.com/github/copilot.vim)
- For Claude: an Anthropic API key with credit: <https://console.anthropic.com>
  (a claude.ai Pro/Max subscription does not include API usage)
- For OpenAI / OpenRouter: an API key from that service
- For local models: [Ollama](https://ollama.com) running (no key needed)

No `npm install`: the server ships as a single bundled file in `dist/`.

## Install

[lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  'ywsrock/copilot-anymodel.nvim',
  dependencies = { 'github/copilot.vim' },
  opts = {},
}
```

[vim-plug](https://github.com/junegunn/vim-plug) / Vundle:

```vim
Plug 'github/copilot.vim'
Plug 'ywsrock/copilot-anymodel.nvim'
```

Do not lazy-load either plugin on an event: the server command has to be set
before copilot.vim starts.

Then, once:

```
:Cop key
```

and paste your Anthropic API key. It is saved to `stdpath('data')/copilot-anymodel/keys/anthropic`
with owner-only permissions. You do **not** need `:Copilot setup` (that is
GitHub's sign-in).

Check everything with `:checkhealth copilot_anymodel`.

## Usage

Start typing in insert mode and pause; a suggestion appears as ghost text
(about one second with the default model).

| Key (insert mode) | Action |
|---|---|
| `<Tab>` | Accept the suggestion |
| `<M-Right>` | Accept the next word |
| `<M-C-Right>` | Accept the next line |
| `<M-]>` / `<M-[>` | Next / previous suggestion |
| `<M-\>` | Request a suggestion now |
| `<C-]>` | Dismiss |

These are copilot.vim's maps; see `:help copilot-maps` to change them.
`:Copilot panel` shows several suggestions side by side.

Keep typing what the suggestion says and it is answered locally, without a new
request.

## Commands

| Command | |
|---|---|
| `:Cop` | Menu of the commands below |
| `:Cop model [id]` | Pick from every model of every configured provider, e.g. `anthropic/claude-haiku-5-5` |
| `:Cop toggle` | Switch between this plugin's server and GitHub Copilot |
| `:Cop backend anymodel\|copilot` | Choose one of the two explicitly |
| `:Cop key [provider]` | Save a provider's API key (`anthropic`, `openai`, `openrouter`, …) |
| `:Cop status` | Show backend, model, key source and paths |
| `:Cop logout [provider]` | Delete a saved API key |

The backend and model choices are remembered across sessions. Each model gets the
fastest settings it accepts (thinking off where possible, low effort); Haiku 5.5,
the default, is the quickest in practice. The `copilot` backend needs a
GitHub Copilot subscription and `:Copilot setup` once.

## Configuration

Everything is optional.

```lua
require('copilot_anymodel').setup({
  default_backend = 'anymodel', -- until :Cop backend picks another
  server = {
    model = 'anthropic/claude-haiku-5-5', -- "<provider>/<model>"; :Cop model overrides it
    debounceMs = 100,           -- wait after the last keystroke
    maxLines = 8,               -- longest multi-line suggestion
    maxTokens = 256,
    linesBefore = 200,          -- context sent above the cursor
    linesAfter = 50,            -- and below it
    alternatives = 2,           -- extra suggestions fetched when cycling
    providers = {},             -- per-provider options (for providers added later)
  },
})
```

A provider's environment variable (`ANTHROPIC_API_KEY`) takes precedence over
its saved key.
copilot.vim options such as `g:copilot_filetypes` keep working.

## Providers

| Provider | Setup | Models in `:Cop model` |
|---|---|---|
| `anthropic` | `:Cop key anthropic` | Every model your key can use, from the Models API |
| `ollama` | Ollama running locally | Every installed model that can generate text |
| `openai` | `:Cop key openai` | GPT and Codex text models (Responses API) |
| `openrouter` | `:Cop key openrouter` | Every model OpenRouter serves |
| your own name | `type = 'openai-compatible'` (below) | Whatever the server lists |

A provider whose key is not set does not appear in `:Cop model`.

**OpenAI** uses the Responses API, which the Codex models require. The lowest
reasoning effort a model accepts is used (`none`, else `minimal`, else `low`).

**OpenAI-compatible servers** (LM Studio, vLLM, llama.cpp server, Ollama's
`/v1`, …) are added under a name of your choice and use Chat Completions:

```lua
server = {
  providers = {
    lmstudio = { type = 'openai-compatible', baseUrl = 'http://localhost:1234/v1' },
    -- with a key: apiKeyEnv = 'MY_SERVER_KEY', or :Cop key lmstudio
  },
},
```

Their models then show up as `lmstudio/<model>`. For Ollama itself prefer the
`ollama` provider: it uses fill-in-the-middle, which small local models
complete much better than the chat prompt.

**Ollama.** Models with the `insert` capability (shown as `FIM`, e.g.
`qwen2.5-coder`) get a fill-in-the-middle request; other models get the chat
prompt. The selected model is loaded when you pick it and kept for 30 minutes.
Local inference re-reads everything after the first changed token on each
keystroke, so Ollama uses smaller defaults: `linesAfter = 15`, `maxLines = 4`,
`maxTokens = 128`, `alternatives = 0`. Override them per provider:

```lua
server = {
  model = 'ollama/qwen2.5-coder:7b',
  providers = {
    ollama = { baseUrl = 'http://localhost:11434', keepAlive = '30m', linesAfter = 30 },
    -- ollama = false,  -- hide Ollama models
  },
},
```

`$OLLAMA_HOST` is honoured when `baseUrl` is not set. Speed depends on your
hardware: `qwen2.5-coder:7b` on an Intel i9 without GPU takes about 3 s to the
first token and 5 s for a one-line suggestion.

## Privacy and cost

- Around the cursor (by default 200 lines above and 50 below) the current file
  is sent to the model's provider for every suggestion; with Ollama it stays
  on your machine (or your Ollama server). Turn it off where that is
  not acceptable:

  ```vim
  " by filetype
  let g:copilot_filetypes = {'*': v:true, 'markdown': v:false}
  " by file name, e.g. secrets
  autocmd BufReadPre *.env,*.pem,*.key let b:copilot_enabled = v:false
  " current buffer only
  let b:copilot_enabled = v:false
  ```

- Claude Haiku 5.5 costs roughly US$0.0003 per suggestion (2–3k input tokens,
  a few dozen output tokens). Check usage in the Anthropic console.

## How it works

copilot.vim talks LSP to a language server it starts from `g:copilot_command`.
This plugin sets that to `node dist/server.mjs`, a small server that implements
the requests copilot.vim sends (`textDocument/inlineCompletion`, the panel,
status, models) and answers them with the provider of the selected model:

- streaming, cut off as soon as enough lines arrived
- Claude: the stable part of the file above the cursor is prompt-cached;
  thinking off and low effort where the model allows it (read from the Models API)
- OpenAI: the lowest reasoning effort the model accepts
- Ollama: fill-in-the-middle for coder models, the model is loaded in advance
- `$/cancelRequest` aborts the request; a short debounce avoids calls while typing

Measured with Claude Haiku 5.5: 0.7–1.0 s to the first token, 0.8–1.3 s total.

Tested with copilot.vim 1.59.0. copilot.vim's protocol is not a public API;
CI runs weekly against its latest version.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No suggestions | `:Copilot status`, then `:checkhealth copilot_anymodel` |
| `No API key for anthropic` | `:Cop key anthropic` |
| `No API key for openai` | `:Cop key openai` (or pick a model of another provider) |
| `Authentication failed (401)` | The key is wrong or revoked; run `:Cop key <provider>` again |
| `credit balance is too low` | Buy API credit in the Anthropic console |
| No Ollama models in `:Cop model` | Start Ollama (`ollama serve`) and check `baseUrl` / `$OLLAMA_HOST` |
| Ollama suggestions are slow | Expected on CPU; see the Ollama defaults above, or use a smaller model |
| Odd suggestions | Start Neovim with `COPILOT_ANYMODEL_DUMP=/tmp/dump.txt nvim` to see each prompt and raw reply |

## Development

```sh
npm ci
npm run build      # server/ -> dist/server.mjs (commit the result)
npm test           # unit + LSP tests with a mock model
npm run test:e2e   # headless Neovim + real copilot.vim + mock model
node server/bench.js [file] [line] [runs] [provider/model]   # real latency (anthropic)
```

## License

MIT. `dist/server.mjs` bundles third-party packages; see
`dist/THIRD_PARTY_LICENSES.txt`.
