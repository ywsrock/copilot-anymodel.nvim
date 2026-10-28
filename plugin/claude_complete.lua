if vim.g.loaded_claude_complete then
  return
end
vim.g.loaded_claude_complete = 1

require('claude_complete').init()
