-- copilot-anymodel.nvim: any model as the completion backend of copilot.vim.
--
-- copilot.vim keeps providing the UI (ghost text, <Tab>, cycling, panel); this
-- module only points copilot.vim at the bundled language server, stores API
-- keys and switches between the bundled server and the official GitHub one.

local M = {}

local uv = vim.uv or vim.loop

local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h')
local backends = { 'anymodel', 'copilot' }

M.paths = {
  server = root .. '/dist/server.mjs',
  key_file = vim.fn.stdpath('data') .. '/copilot-anymodel/api_key',
  backend_file = vim.fn.stdpath('state') .. '/copilot-anymodel/backend',
  model_file = vim.fn.stdpath('state') .. '/copilot-anymodel/model',
}

M.config = {
  -- Backend used until :Cop backend picks another one.
  default_backend = 'anymodel',
  -- Passed to the server, e.g. { model = 'claude-sonnet-5-5', debounceMs = 50 }.
  server = {},
}

local function notify(msg, level)
  vim.notify('Cop: ' .. msg, level or vim.log.levels.INFO)
end

local function valid_backend(name)
  return vim.tbl_contains(backends, name)
end

local function read_file(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  return ok and lines[1] or nil
end

function M.node_command()
  local node = vim.g.copilot_node_command
  if type(node) == 'string' and node ~= '' then
    return vim.fn.expand(node)
  end
  return 'node'
end

function M.saved_backend()
  local name = read_file(M.paths.backend_file)
  return valid_backend(name) and name or M.config.default_backend
end

-- Where the API key comes from: 'env', 'file' or nil.
function M.key_source()
  if (vim.env.ANTHROPIC_API_KEY or '') ~= '' then
    return 'env'
  end
  if vim.trim(read_file(M.paths.key_file) or '') ~= '' then
    return 'file'
  end
  return nil
end

-- Model picked with :Cop model, or nil.
function M.saved_model()
  local model = vim.trim(read_file(M.paths.model_file) or '')
  return model ~= '' and model or nil
end

local function is_claude_model(id)
  return type(id) == 'string' and id:match('^claude%-') ~= nil
end

-- :Copilot model stores its choice in g:copilot_settings, which both backends
-- receive. Drops it when it would override :Cop model or reach GitHub.
local function clear_copilot_model(keep)
  local settings = vim.g.copilot_settings
  if type(settings) == 'table' and is_claude_model(settings.selectedCompletionModel)
      and settings.selectedCompletionModel ~= keep then
    settings.selectedCompletionModel = nil
    vim.g.copilot_settings = settings
  end
end

local function apply(backend)
  vim.g.copilot_anymodel_backend = backend
  if backend == 'anymodel' then
    vim.g.copilot_command = { M.node_command(), M.paths.server, '--key-file', M.paths.key_file }
  else
    -- Unset: copilot.vim then starts GitHub's own language server.
    vim.g.copilot_command = nil
    clear_copilot_model()
  end
  local server = vim.deepcopy(M.config.server)
  server.model = M.saved_model() or server.model
  if not vim.tbl_isempty(server) then
    local settings = vim.g.copilot_lsp_settings or {}
    settings.anymodel = server
    vim.g.copilot_lsp_settings = settings
  end
end

-- Sends the current settings to a running server; no restart needed.
local function push_settings()
  vim.cmd('if copilot#RunningClient() isnot v:null | call copilot#RunningClient().DidChangeConfiguration() | endif')
end

local function restart()
  if vim.fn.exists(':Copilot') == 2 and vim.v.vim_did_enter == 1 then
    vim.cmd('silent Copilot restart')
  end
end

function M.set_backend(name)
  if not valid_backend(name) then
    notify('unknown backend ' .. vim.inspect(name) .. ' (use anymodel or copilot)', vim.log.levels.ERROR)
    return
  end
  vim.fn.mkdir(vim.fn.fnamemodify(M.paths.backend_file, ':h'), 'p')
  vim.fn.writefile({ name }, M.paths.backend_file)
  apply(name)
  restart()
  if name == 'anymodel' and not M.key_source() then
    notify('backend: anymodel (no API key yet, run :Cop key)', vim.log.levels.WARN)
  elseif name == 'copilot' then
    notify('backend: copilot (run :Copilot setup once if you are not signed in to GitHub)')
  else
    notify('backend: ' .. name)
  end
end

function M.toggle()
  M.set_backend(vim.g.copilot_anymodel_backend == 'anymodel' and 'copilot' or 'anymodel')
end

-- Accepts a pasted shell line such as `export ANTHROPIC_API_KEY="sk-ant-..."`
-- (same rules as normalizeKey in server/lib/credentials.js).
function M.normalize_key(text)
  local key = vim.trim(text)
  key = key:gsub('^export%s+', '')
  key = key:gsub('^ANTHROPIC_API_KEY%s*=%s*', '')
  key = key:gsub('^(["\'])(.*)%1$', '%2')
  return vim.trim(key)
end

-- Saves the key with owner-only permissions; the running server picks it up
-- on the next request, no restart needed.
function M.setup_key()
  local key = M.normalize_key(vim.fn.inputsecret('Anthropic API key (https://console.anthropic.com): '))
  vim.cmd('redraw')
  if key == '' then
    notify('cancelled')
    return
  end
  if not key:match('^sk%-ant%-') then
    notify('the key does not start with "sk-ant-", saving anyway', vim.log.levels.WARN)
  end
  local dir = vim.fn.fnamemodify(M.paths.key_file, ':h')
  vim.fn.mkdir(dir, 'p', tonumber('700', 8))
  local tmp = M.paths.key_file .. '.tmp'
  local fd = assert(uv.fs_open(tmp, 'w', tonumber('600', 8)))
  uv.fs_write(fd, key .. '\n')
  uv.fs_close(fd)
  uv.fs_chmod(tmp, tonumber('600', 8))
  assert(uv.fs_rename(tmp, M.paths.key_file))
  notify('API key saved to ' .. M.paths.key_file)
  if vim.env.ANTHROPIC_API_KEY and vim.env.ANTHROPIC_API_KEY ~= '' then
    notify('note: ANTHROPIC_API_KEY is set and takes precedence over the saved key', vim.log.levels.WARN)
  end
end

function M.set_model(id)
  vim.fn.mkdir(vim.fn.fnamemodify(M.paths.model_file, ':h'), 'p')
  vim.fn.writefile({ id }, M.paths.model_file)
  clear_copilot_model(id)
  apply(vim.g.copilot_anymodel_backend)
  if vim.g.copilot_anymodel_backend == 'anymodel' then
    push_settings()
  end
  notify('model: ' .. id)
end

-- Models the API key can use, as reported by the running server.
function M.list_models()
  local response = vim.fn.eval("copilot#Client().Request('copilot/models', {}).Wait()")
  if response.status ~= 'success' then
    return nil, vim.tbl_get(response, 'error', 'message') or 'request failed'
  end
  return response.result
end

-- Ids for command-line completion, refreshed by each listing.
local model_cache = { 'claude-haiku-5-5', 'claude-sonnet-5-5' }

-- Without an id, lists every available model and lets the user pick one.
function M.select_model(id)
  if id then
    M.set_model(id)
    return
  end
  if vim.g.copilot_anymodel_backend ~= 'anymodel' then
    notify('model selection needs the anymodel backend (use :Copilot model for GitHub models)', vim.log.levels.WARN)
    return
  end
  local models, err = M.list_models()
  if not models then
    notify('could not list models: ' .. err, vim.log.levels.ERROR)
    return
  end
  model_cache = vim.tbl_map(function(m) return m.id end, models)
  vim.ui.select(models, {
    prompt = 'Claude model',
    format_item = function(m)
      return string.format('%s%s (%s)%s', m.current and '* ' or '  ', m.modelName, m.id, m.deprecated and ' [deprecated]' or '')
    end,
  }, function(choice)
    if choice then
      M.set_model(choice.id)
    end
  end)
end

function M.logout()
  if vim.fn.filereadable(M.paths.key_file) == 1 then
    vim.fn.delete(M.paths.key_file)
    notify('saved API key deleted')
  else
    notify('no saved API key')
  end
end

function M.status()
  local source = M.key_source()
  print(table.concat({
    'backend:  ' .. tostring(vim.g.copilot_anymodel_backend),
    'model:    ' .. (M.saved_model() or M.config.server.model or 'claude-haiku-5-5 (default)'),
    'api key:  ' .. (source == 'env' and 'ANTHROPIC_API_KEY' or source == 'file' and M.paths.key_file or 'not set'),
    'server:   ' .. M.paths.server,
    'node:     ' .. M.node_command(),
  }, '\n'))
end

local subcommands = {
  key = M.setup_key,
  backend = function(arg)
    if arg then
      M.set_backend(arg)
    else
      notify('backend: ' .. tostring(vim.g.copilot_anymodel_backend))
    end
  end,
  toggle = M.toggle,
  model = M.select_model,
  status = M.status,
  logout = M.logout,
}

local menu = {
  { 'model', 'Pick a model' },
  { 'toggle', 'Switch between anymodel and GitHub Copilot' },
  { 'key', 'Save an API key' },
  { 'status', 'Show backend, model and key' },
  { 'logout', 'Delete the saved API key' },
}

-- :Cop without arguments: choose an action from a list.
function M.menu()
  vim.ui.select(menu, {
    prompt = 'Cop',
    format_item = function(item)
      return string.format('%-7s %s', item[1], item[2])
    end,
  }, function(choice)
    if choice then
      subcommands[choice[1]]()
    end
  end)
end

local function command(opts)
  local name, arg = opts.fargs[1], opts.fargs[2]
  if not name then
    M.menu()
    return
  end
  local fn = subcommands[name]
  if not fn then
    notify('unknown subcommand ' .. name, vim.log.levels.ERROR)
    return
  end
  fn(arg)
end

local function complete(_, line)
  local args = vim.split(line, '%s+', { trimempty = true })
  local n = #args + (line:match('%s$') and 1 or 0)
  if n <= 2 then
    return vim.tbl_keys(subcommands)
  elseif n == 3 and args[2] == 'backend' then
    return backends
  elseif n == 3 and args[2] == 'model' then
    return model_cache
  end
  return {}
end

-- Runs at startup from plugin/, before copilot.vim starts its client on VimEnter.
function M.init()
  apply(M.saved_backend())
  vim.api.nvim_create_user_command('Cop', command, {
    nargs = '*',
    complete = complete,
    desc = 'copilot-anymodel: model [id] | toggle | backend [anymodel|copilot] | key | status | logout',
  })
end

-- Optional, for plugin managers: require('copilot_anymodel').setup({ ... })
function M.setup(opts)
  M.config = vim.tbl_deep_extend('force', M.config, opts or {})
  apply(M.saved_backend())
  restart()
end

return M
