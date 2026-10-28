# Changelog

## 0.1.0 — 2026-10-28

First release.

- copilot.vim keeps the UI; `g:copilot_command` points it at a bundled
  language server that asks the model you choose
- Providers: `anthropic` (Claude, models from the Models API), `openai`
  (Responses API, including Codex), `openrouter`, `ollama` (fill-in-the-middle
  for coder models) and any `openai-compatible` server
- `:Cop` command: `model`, `toggle`, `backend`, `key`, `status`, `logout`,
  and a menu when run without arguments
- API keys stored per provider with owner-only permissions; each provider's
  environment variable takes precedence
- `:checkhealth copilot_anymodel`
