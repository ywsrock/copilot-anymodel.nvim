# claude-complete.nvim

Inline code completion for Neovim powered by Claude, using the familiar
[copilot.vim](https://github.com/github/copilot.vim) interface.

copilot.vim keeps doing what it does well (ghost text, `<Tab>` to accept,
cycling, the panel). This plugin swaps the language server behind it for one
that asks Claude, and lets you switch back to GitHub's server with one command.

> Not affiliated with GitHub or Anthropic. "GitHub Copilot" is a trademark of
> GitHub, Inc. You use your own Anthropic API key and pay Anthropic directly.

[日本語](README.ja.md)

## Requirements

- Neovim 0.10+ (tested on 0.12)
- Node.js 20+ (copilot.vim needs it too)
- [copilot.vim](https://github.com/github/copilot.vim)
- An Anthropic API key with credit: <https://console.anthropic.com>
  (a claude.ai Pro/Max subscription does not include API usage)

No `npm install`: the server ships as a single bundled file in `dist/`.

## Install

[lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  'ywsrock/claude-complete.nvim',
  dependencies = { 'github/copilot.vim' },
  opts = {},
}
```

[vim-plug](https://github.com/junegunn/vim-plug) / Vundle:

```vim
Plug 'github/copilot.vim'
Plug 'ywsrock/claude-complete.nvim'
```

Do not lazy-load either plugin on an event: the server command has to be set
before copilot.vim starts.

Then, once:

```
:ClaudeComplete setup
```

and paste your API key. It is saved to `stdpath('data')/claude-complete/api_key`
with owner-only permissions. You do **not** need `:Copilot setup` (that is
GitHub's sign-in).

Check everything with `:checkhealth claude_complete`.

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
| `:ClaudeComplete setup` | Save your Anthropic API key |
| `:ClaudeComplete backend claude\|copilot` | Use Claude, or GitHub's own Copilot server |
| `:ClaudeComplete toggle` | Switch to the other backend |
| `:ClaudeComplete info` | Show backend, key source and paths |
| `:ClaudeComplete logout` | Delete the saved API key |
| `:Copilot status` | `Ready`, or what is wrong (missing key, no credit, …) |
| `:Copilot model` | Pick Claude Haiku 5.5 (default) or Claude Sonnet 5.5 |
| `:Copilot log` | Per-request latency (`ttft`, `total`) and errors |

The backend choice is remembered across sessions. The `copilot` backend needs a
GitHub Copilot subscription and `:Copilot setup` once.

## Configuration

Everything is optional.

```lua
require('claude_complete').setup({
  default_backend = 'claude', -- until :ClaudeComplete backend picks another
  server = {
    model = 'claude-haiku-5-5', -- or 'claude-sonnet-5-5'
    debounceMs = 100,           -- wait after the last keystroke
    maxLines = 8,               -- longest multi-line suggestion
    maxTokens = 256,
    linesBefore = 200,          -- context sent above the cursor
    linesAfter = 50,            -- and below it
    alternatives = 2,           -- extra suggestions fetched when cycling
  },
})
```

`ANTHROPIC_API_KEY` in the environment takes precedence over the saved key.
copilot.vim options such as `g:copilot_filetypes` keep working.

## Privacy and cost

- Around the cursor (by default 200 lines above and 50 below) the current file
  is sent to the Anthropic API for every suggestion. Turn it off where that is
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
status, models) and answers them with the Claude Messages API:

- streaming, cut off as soon as enough lines arrived
- the stable part of the file above the cursor is prompt-cached
- thinking disabled and low effort, for latency
- `$/cancelRequest` aborts the API call; a short debounce avoids calls while typing

Measured with Claude Haiku 5.5: 0.7–1.0 s to the first token, 0.8–1.3 s total.

Tested with copilot.vim 1.59.0. copilot.vim's protocol is not a public API;
CI runs weekly against its latest version.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No suggestions | `:Copilot status`, then `:checkhealth claude_complete` |
| `No Anthropic API key` | `:ClaudeComplete setup` |
| `Authentication failed (401)` | The key is wrong or revoked; run `:ClaudeComplete setup` again |
| `credit balance is too low` | Buy API credit in the Anthropic console |
| Odd suggestions | Start Neovim with `CLAUDE_COMPLETE_DUMP=/tmp/dump.txt nvim` to see each prompt and raw reply |

## Development

```sh
npm ci
npm run build      # server/ -> dist/server.mjs (commit the result)
npm test           # unit + LSP tests with a mock model
npm run test:e2e   # headless Neovim + real copilot.vim + mock model
node server/bench.js [file] [line] [runs] [model]   # real latency
```

## License

MIT. `dist/server.mjs` bundles third-party packages; see
`dist/THIRD_PARTY_LICENSES.txt`.
