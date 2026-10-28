if vim.g.loaded_copilot_anymodel then
  return
end
vim.g.loaded_copilot_anymodel = 1

require('copilot_anymodel').init()
