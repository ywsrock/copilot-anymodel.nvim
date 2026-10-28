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

  local source = cc.key_source()
  if source == 'env' then
    health.ok('API key from ANTHROPIC_API_KEY')
  elseif source == 'file' then
    health.ok('API key from ' .. cc.paths.key_file)
  elseif backend == 'anymodel' then
    health.error('no Anthropic API key', 'Run :Cop key')
  else
    health.info('no Anthropic API key (only needed for the anymodel backend)')
  end
end

return M
