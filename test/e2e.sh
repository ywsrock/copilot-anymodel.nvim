#!/bin/sh
# Headless Neovim test with the real copilot.vim and the mock provider.
# Runs in throwaway XDG dirs so it never touches your saved key or backend.
set -eu
cd "$(dirname "$0")/.."

deps=test/.deps
if [ ! -d "$deps/copilot.vim" ]; then
  git clone --depth 1 -q https://github.com/github/copilot.vim "$deps/copilot.vim"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" XDG_STATE_HOME="$tmp/state" XDG_CACHE_HOME="$tmp/cache"
export CLAUDE_COMPLETE_PROVIDER=mock CLAUDE_COMPLETE_MOCK_TEXT='a + b;\n}'
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN || true

nvim --headless -u test/minimal_init.lua -c 'luafile test/e2e.lua'
