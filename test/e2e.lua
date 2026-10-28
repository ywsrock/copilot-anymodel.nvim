-- Driven by test/e2e.sh. Exits 0 on success, 1 on the first failure.

local cc = require('claude_complete')
local failures = 0

local function check(name, ok, detail)
  print((ok and 'ok   ' or 'FAIL ') .. name .. (ok and '' or ('  ' .. vim.inspect(detail))))
  if not ok then
    failures = failures + 1
  end
end

local function finish()
  vim.cmd(failures == 0 and 'qa!' or 'cquit 1')
end

local function status()
  vim.cmd('call copilot#Client().StartupError()')
  vim.wait(300)
  return vim.trim(vim.fn.execute('Copilot status'))
end

-- 1. The plugin points copilot.vim at the bundled server.
local cmd = vim.g.copilot_command
check('copilot_command uses the bundle', type(cmd) == 'table' and cmd[2] == cc.paths.server, cmd)
check('default backend is claude', vim.g.claude_complete_backend == 'claude', vim.g.claude_complete_backend)

-- 2. :ClaudeComplete setup stores the key readable only by the owner.
vim.api.nvim_feedkeys('sk-ant-test-key\r', 'n', false)
vim.cmd('ClaudeComplete setup')
local stat = (vim.uv or vim.loop).fs_stat(cc.paths.key_file)
check('key saved', vim.fn.readfile(cc.paths.key_file)[1] == 'sk-ant-test-key')
check('key file mode 600', stat and bit.band(stat.mode, tonumber('777', 8)) == tonumber('600', 8), stat and stat.mode)
check('key source is file', cc.key_source() == 'file', cc.key_source())
check('pasted shell line is cleaned', cc.normalize_key("export ANTHROPIC_API_KEY='sk-ant-x'") == 'sk-ant-x', cc.normalize_key("export ANTHROPIC_API_KEY='sk-ant-x'"))

-- 3. A completion request goes through copilot.vim.
vim.cmd('enew')
vim.bo.filetype = 'javascript'
vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'function add(a, b) {', '  return ' })
vim.api.nvim_win_set_cursor(0, { 2, 9 })
check('status is Ready', status():find('Ready') ~= nil, status())
local result = vim.fn['copilot#Complete']()
local items = type(result) == 'table' and result.items or {}
check('inline completion', items[1] and items[1].insertText == '  return a + b;\n}', result)

-- 4. Backend switching.
vim.cmd('ClaudeComplete backend copilot')
check('copilot backend unsets copilot_command', vim.g.copilot_command == nil, vim.g.copilot_command)
check('backend is saved', vim.fn.readfile(cc.paths.backend_file)[1] == 'copilot')
vim.cmd('ClaudeComplete toggle')
check('toggle returns to claude', vim.g.claude_complete_backend == 'claude' and vim.g.copilot_command ~= nil)
check('server restarted', status():find('Ready') ~= nil, status())

-- 5. Model listing and selection.
local models = cc.list_models() or {}
check('model list from server', #models == 2 and models[1].current == true, models)
vim.g.copilot_settings = { selectedCompletionModel = 'claude-old' }
vim.cmd('ClaudeComplete model mock-2')
check('model is saved', cc.saved_model() == 'mock-2', cc.saved_model())
check('stale :Copilot model choice dropped', vim.g.copilot_settings.selectedCompletionModel == nil, vim.g.copilot_settings)
vim.wait(100)
local current = vim.tbl_filter(function(m) return m.current end, cc.list_models() or {})
check('server uses the selected model', current[1] and current[1].id == 'mock-2', current)

-- 6. Ghost text and <Tab> accept in insert mode.
vim.cmd('enew')
vim.bo.filetype = 'javascript'
vim.api.nvim_buf_set_lines(0, 0, -1, false, { 'function add(a, b) {', '  return ' })
vim.api.nvim_win_set_cursor(0, { 2, 9 })
vim.fn.feedkeys('A', 'nt')

local tries = 0
local function wait_ghost()
  local shown = vim.fn['copilot#GetDisplayedSuggestion']().text
  if shown ~= '' then
    check('ghost text shown', shown == 'a + b;\n}', shown)
    vim.fn.feedkeys(vim.fn['copilot#Accept']() .. vim.keycode('<Esc>'), 'nt')
    vim.defer_fn(function()
      local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
      check('accepted into buffer', vim.deep_equal(lines, { 'function add(a, b) {', '  return a + b;', '}' }), lines)
      finish()
    end, 200)
  elseif tries > 50 then
    check('ghost text shown', false, 'timeout')
    finish()
  else
    tries = tries + 1
    vim.defer_fn(wait_ghost, 100)
  end
end
vim.defer_fn(wait_ghost, 300)
