-- Minimal config for recording docs/demo.gif: copilot.vim + this plugin only.
--   python3 docs/demo/record.py   (needs an Anthropic key saved with :Cop key)
local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h')
vim.opt.rtp:prepend(vim.env.COPILOT_VIM or vim.fn.expand('~/.vim/bundle/copilot.vim'))
vim.opt.rtp:prepend(root)
vim.o.termguicolors = true
vim.o.number = true
vim.o.laststatus = 0
vim.o.ruler = false
vim.o.showmode = true
vim.o.swapfile = false
vim.g.copilot_filetypes = { ['*'] = true }
vim.cmd.colorscheme('habamax')
-- Suggestions carry their own indentation; no autoindent keeps the typed keys simple.
vim.cmd('filetype indent off')
vim.o.autoindent = false
