-- :checkhealth copilot_anymodel

local M = {}

function M.check()
  local cc = require('copilot_anymodel')
  local health = vim.health

  health.start('copilot-anymodel')

  local node = cc.node_command()
  if vim.fn.executable(node) == 1 then
    local version = vim.trim(vim.fn.system({ node, '--version' }))
    local major = tonumber(version:match('^v(%d+)'))
    if major and major >= 20 then
      health.ok('Node.js ' .. version)
    else
      health.error('Node.js ' .. version .. ' is too old', 'Install Node.js 20 or newer')
    end
  else
    health.error('Node.js not found: ' .. node, 'Install Node.js 20+ or set g:copilot_node_command')
  end

  if vim.fn.exists('g:loaded_copilot') == 1 then
    health.ok('copilot.vim is loaded')
  else
    health.error('copilot.vim is not loaded', 'Install github/copilot.vim; it provides the completion UI')
  end

  if vim.fn.filereadable(cc.paths.server) == 1 then
    health.ok('server: ' .. cc.paths.server)
  else
    health.error('server bundle missing: ' .. cc.paths.server, 'Reinstall the plugin')
  end

  local backend = vim.g.copilot_anymodel_backend
  health.info('backend: ' .. tostring(backend) .. ' (switch with :Cop toggle)')

  local active = cc.model_provider()
  health.info('model provider: ' .. active .. ' (pick a model with :Cop model)')
  for _, provider in ipairs(cc.key_provider_names()) do
    local source = cc.key_source(provider)
    if source == 'env' then
      health.ok(provider .. ' API key from ' .. cc.key_info(provider).env)
    elseif source == 'file' then
      health.ok(provider .. ' API key from ' .. cc.key_file(provider))
    elseif backend == 'anymodel' and provider == active and cc.key_providers[provider] then
      health.error('no ' .. provider .. ' API key', 'Run :Cop key ' .. provider)
    elseif cc.key_providers[provider] then
      health.info('no ' .. provider .. ' API key (only needed for ' .. provider .. ' models)')
    end
  end
end

return M
