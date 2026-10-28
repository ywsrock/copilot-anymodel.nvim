# claude-complete.nvim

[copilot.vim](https://github.com/github/copilot.vim) の操作感のまま、補完を Claude で行う Neovim プラグイン。

ゴーストテキスト、`<Tab>` での受け入れ、候補の切り替え、パネルは copilot.vim がそのまま担当し、
このプラグインは裏の language server を Claude を使うものに差し替える。
GitHub 純正のサーバーへもコマンド 1 つで戻せる。

> GitHub・Anthropic とは無関係の非公式プラグイン。"GitHub Copilot" は GitHub, Inc. の商標。
> 利用者自身の Anthropic API キーで動き、料金は Anthropic に直接支払う。

[English](README.md)

## 必要なもの

- Neovim 0.10 以上（0.12 で動作確認）
- Node.js 20 以上（copilot.vim も必要とする）
- [copilot.vim](https://github.com/github/copilot.vim)
- クレジット残高のある Anthropic API キー（<https://console.anthropic.com>）
  ※ claude.ai の Pro / Max 契約には API 利用料は含まれない

サーバーは `dist/` に 1 ファイルで同梱しているので `npm install` は不要。

## インストール

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

どちらのプラグインもイベントで遅延読み込みしないこと（copilot.vim の起動前にサーバーの設定が必要なため）。

インストール後に 1 回だけ:

```
:ClaudeComplete setup
```

を実行して API キーを貼り付ける。キーは `stdpath('data')/claude-complete/api_key`
（macOS / Linux では `~/.local/share/nvim/claude-complete/api_key`）に本人だけが読める権限で保存される。
`:Copilot setup`（GitHub へのログイン）は不要。

`:checkhealth claude_complete` で Node、copilot.vim、API キーをまとめて確認できる。

## 使い方

挿入モードで入力を止めると、灰色のゴーストテキストで候補が出る（既定のモデルで約 1 秒）。

| キー（挿入モード） | 動作 |
|---|---|
| `<Tab>` | 候補を受け入れる |
| `<M-Right>` | 1 単語だけ受け入れる |
| `<M-C-Right>` | 1 行だけ受け入れる |
| `<M-]>` / `<M-[>` | 次 / 前の候補 |
| `<M-\>` | 今すぐ候補を出す |
| `<C-]>` | 候補を消す |

キーは copilot.vim のもの。変更方法は `:help copilot-maps`。
`:Copilot panel` で複数の候補を並べて比較できる。

候補どおりに打ち進めている間は、API を呼ばずに残りが表示される。

## コマンド

| コマンド | 内容 |
|---|---|
| `:ClaudeComplete setup` | API キーを保存 |
| `:ClaudeComplete backend claude\|copilot` | Claude / GitHub 純正サーバーを選ぶ |
| `:ClaudeComplete toggle` | もう一方に切り替え |
| `:ClaudeComplete info` | バックエンド、キーの読み込み元、パスを表示 |
| `:ClaudeComplete logout` | 保存した API キーを削除 |
| `:Copilot status` | `Ready`、または問題（キー未設定、残高不足など） |
| `:Copilot model` | Claude Haiku 5.5（既定）/ Claude Sonnet 5.5 を選ぶ |
| `:Copilot log` | リクエストごとのレイテンシ（`ttft`, `total`）とエラー |

選んだバックエンドは次回の起動時も使われる。`copilot` バックエンドには GitHub Copilot の契約と、
初回だけ `:Copilot setup` が必要。

## 設定

すべて任意。

```lua
require('claude_complete').setup({
  default_backend = 'claude', -- :ClaudeComplete backend で選ぶまでの既定
  server = {
    model = 'claude-haiku-5-5', -- または 'claude-sonnet-5-5'
    debounceMs = 100,           -- 最後のキー入力から待つ時間
    maxLines = 8,               -- 複数行の候補の最大行数
    maxTokens = 256,
    linesBefore = 200,          -- カーソルより上に送る行数
    linesAfter = 50,            -- 下に送る行数
    alternatives = 2,           -- 候補切り替え時に追加で取る数
  },
})
```

環境変数 `ANTHROPIC_API_KEY` があれば、保存したキーより優先される。
`g:copilot_filetypes` など copilot.vim の設定はそのまま使える。

## データ送信と費用

- 候補を出すたびに、編集中ファイルのカーソル周辺（既定で上 200 行・下 50 行）が Anthropic API に送られる。
  送りたくないファイルでは止める:

  ```vim
  " ファイルの種類で
  let g:copilot_filetypes = {'*': v:true, 'markdown': v:false}
  " ファイル名で（秘密情報など）
  autocmd BufReadPre *.env,*.pem,*.key let b:copilot_enabled = v:false
  " 今のバッファだけ
  let b:copilot_enabled = v:false
  ```

- Claude Haiku 5.5 で 1 回あたり約 US$0.0003（入力 2〜3k トークン、出力数十トークン）。
  使用量は Anthropic のコンソールで確認できる。

## 仕組み

copilot.vim は `g:copilot_command` で指定された language server と LSP で通信する。
このプラグインはそこを `node dist/server.mjs` に設定する。このサーバーは copilot.vim が送るリクエスト
（`textDocument/inlineCompletion`、パネル、状態、モデル一覧）を実装し、Claude の Messages API で答える。

- ストリーミングで受け、必要な行数が揃った時点で打ち切る
- カーソルより上の変わりにくい部分をプロンプトキャッシュに乗せる
- 遅延を減らすため thinking 無効・effort low
- `$/cancelRequest` で API 呼び出しを中断し、短いデバウンスで入力中の呼び出しを抑える

Claude Haiku 5.5 での実測: 最初のトークンまで 0.7〜1.0 秒、完了まで 0.8〜1.3 秒。

copilot.vim 1.59.0 で動作確認。copilot.vim のプロトコルは公開 API ではないため、
CI で毎週、最新の copilot.vim との組み合わせをテストしている。

## うまく動かないとき

| 症状 | 対処 |
|---|---|
| 候補が出ない | `:Copilot status`、次に `:checkhealth claude_complete` |
| `No Anthropic API key` | `:ClaudeComplete setup` |
| `Authentication failed (401)` | キーが誤り・無効。`:ClaudeComplete setup` をやり直す |
| `credit balance is too low` | Anthropic のコンソールでクレジットを購入 |
| おかしな候補が出る | `CLAUDE_COMPLETE_DUMP=/tmp/dump.txt nvim` で起動し、送ったプロンプトと生の応答を確認 |

## 開発

```sh
npm ci
npm run build      # server/ -> dist/server.mjs（結果もコミットする）
npm test           # mock モデルで単体テストと LSP の往復テスト
npm run test:e2e   # headless Neovim + 本物の copilot.vim + mock モデル
node server/bench.js [file] [line] [runs] [model]   # 実際のレイテンシ計測
```

## ライセンス

MIT。`dist/server.mjs` は第三者のパッケージを同梱している（`dist/THIRD_PARTY_LICENSES.txt` 参照）。
