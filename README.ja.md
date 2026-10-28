# copilot-anymodel.nvim

[copilot.vim](https://github.com/github/copilot.vim) の操作感のまま、裏のモデルを選べる Neovim プラグイン。
Claude、OpenAI（Codex を含む）、OpenRouter、Ollama 経由のローカルモデル、OpenAI 互換の任意のサーバーに対応。

ゴーストテキスト、`<Tab>` での受け入れ、候補の切り替え、パネルは copilot.vim がそのまま担当し、
このプラグインは裏の language server を、選んだモデルを使うものに差し替える。
`:Cop toggle` で GitHub 純正のサーバーに戻せる。

> GitHub・Anthropic とは無関係の非公式プラグイン。"GitHub Copilot" は GitHub, Inc. の商標。
> 利用者自身の Anthropic API キーで動き、料金は Anthropic に直接支払う。

[English](README.md)

## 必要なもの

- Neovim 0.10 以上（0.12 で動作確認）
- Node.js 20 以上（copilot.vim も必要とする）
- [copilot.vim](https://github.com/github/copilot.vim)
- Claude を使う場合: クレジット残高のある Anthropic API キー（<https://console.anthropic.com>）
  ※ claude.ai の Pro / Max 契約には API 利用料は含まれない
- OpenAI / OpenRouter を使う場合: そのサービスの API キー
- ローカルモデルを使う場合: 起動中の [Ollama](https://ollama.com)（キー不要）

サーバーは `dist/` に 1 ファイルで同梱しているので `npm install` は不要。

## インストール

[lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  'ywsrock/copilot-anymodel.nvim',
  dependencies = { 'github/copilot.vim' },
  opts = {},
}
```

[vim-plug](https://github.com/junegunn/vim-plug) / Vundle:

```vim
Plug 'github/copilot.vim'
Plug 'ywsrock/copilot-anymodel.nvim'
```

どちらのプラグインもイベントで遅延読み込みしないこと（copilot.vim の起動前にサーバーの設定が必要なため）。

インストール後に 1 回だけ:

```
:Cop key
```

を実行して Anthropic の API キーを貼り付ける。キーは `stdpath('data')/copilot-anymodel/keys/anthropic`
（macOS / Linux では `~/.local/share/nvim/copilot-anymodel/keys/anthropic`）に本人だけが読める権限で保存される。
`:Copilot setup`（GitHub へのログイン）は不要。

`:checkhealth copilot_anymodel` で Node、copilot.vim、API キーをまとめて確認できる。

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
| `:Cop` | 下のコマンドをメニューから選ぶ |
| `:Cop model [id]` | 設定済みの全プロバイダのモデルから選ぶ（例 `anthropic/claude-haiku-5-5`） |
| `:Cop toggle` | 同梱サーバー ⇔ GitHub Copilot を切り替え |
| `:Cop backend anymodel\|copilot` | 同梱サーバー / GitHub 純正サーバーを選ぶ |
| `:Cop key [provider]` | プロバイダの API キーを保存（`anthropic`、`openai`、`openrouter` など） |
| `:Cop status` | バックエンド、モデル、キーの読み込み元、パスを表示 |
| `:Cop logout [provider]` | 保存した API キーを削除 |

選んだバックエンドとモデルは次回の起動時も使われる。各モデルには、そのモデルが受け付ける
最速の設定（可能なら thinking 無効、effort low）が自動で使われる。実測では既定の Haiku 5.5 が最も速い。
`copilot` バックエンドには GitHub Copilot の契約と、
初回だけ `:Copilot setup` が必要。

## 設定

すべて任意。

```lua
require('copilot_anymodel').setup({
  default_backend = 'anymodel', -- :Cop backend で選ぶまでの既定
  server = {
    model = 'anthropic/claude-haiku-5-5', -- "<プロバイダ>/<モデル>"。:Cop model の選択が優先
    debounceMs = 100,           -- 最後のキー入力から待つ時間
    maxLines = 8,               -- 複数行の候補の最大行数
    maxTokens = 256,
    linesBefore = 200,          -- カーソルより上に送る行数
    linesAfter = 50,            -- 下に送る行数
    alternatives = 2,           -- 候補切り替え時に追加で取る数
    providers = {},             -- プロバイダごとの設定（今後追加するプロバイダ用）
  },
})
```

プロバイダの環境変数（`ANTHROPIC_API_KEY`）があれば、保存したキーより優先される。
`g:copilot_filetypes` など copilot.vim の設定はそのまま使える。

## プロバイダ

| プロバイダ | 準備 | `:Cop model` に出るモデル |
|---|---|---|
| `anthropic` | `:Cop key anthropic` | キーで使える全モデル（Models API から取得） |
| `ollama` | Ollama を起動しておく | インストール済みで文章を生成できる全モデル |
| `openai` | `:Cop key openai` | GPT・Codex の文章生成モデル（Responses API） |
| `openrouter` | `:Cop key openrouter` | OpenRouter が提供する全モデル |
| 任意の名前 | `type = 'openai-compatible'`（下記） | そのサーバーが返すモデル |

キーが未設定のプロバイダは `:Cop model` に出ない。

**OpenAI** は、Codex 系モデルが必須とする Responses API を使う。reasoning effort は
モデルが受け付ける最も低い値（`none`、だめなら `minimal`、だめなら `low`）を自動で選ぶ。

**OpenAI 互換サーバー**（LM Studio、vLLM、llama.cpp server、Ollama の `/v1` など）は、
好きな名前で追加でき、Chat Completions API を使う:

```lua
server = {
  providers = {
    lmstudio = { type = 'openai-compatible', baseUrl = 'http://localhost:1234/v1' },
    -- キーが要る場合: apiKeyEnv = 'MY_SERVER_KEY'、または :Cop key lmstudio
  },
},
```

モデルは `lmstudio/<モデル名>` として一覧に出る。Ollama 自体は `ollama` プロバイダの方がよい。
FIM 方式を使うので、小さなローカルモデルでもチャット方式よりずっと正確に補完できる。

**Ollama について。** `insert` 機能を持つモデル（一覧で `FIM` と表示。例 `qwen2.5-coder`）は
カーソル前後を渡して間を埋める FIM 方式で、それ以外のモデルはチャット方式で補完する。
モデルは選んだ時点で読み込まれ、30 分間メモリに残る。
ローカル実行では、入力のたびに変更箇所より後ろを読み直すため、Ollama では既定値を小さくしている
（`linesAfter = 15`、`maxLines = 4`、`maxTokens = 128`、`alternatives = 0`）。プロバイダごとに変更できる:

```lua
server = {
  model = 'ollama/qwen2.5-coder:7b',
  providers = {
    ollama = { baseUrl = 'http://localhost:11434', keepAlive = '30m', linesAfter = 30 },
    -- ollama = false,  -- Ollama のモデルを一覧に出さない
  },
},
```

`baseUrl` を指定しなければ `$OLLAMA_HOST` が使われる。速度は機械次第で、GPU なしの Intel i9 で
`qwen2.5-coder:7b` の場合、最初のトークンまで約 3 秒、1 行の候補で約 5 秒。

## データ送信と費用

- 候補を出すたびに、編集中ファイルのカーソル周辺（既定で上 200 行・下 50 行）がモデルの提供元に送られる。
  Ollama の場合は手元の機械（または指定した Ollama サーバー）から出ない。
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
| 候補が出ない | `:Copilot status`、次に `:checkhealth copilot_anymodel` |
| `No API key for anthropic` | `:Cop key anthropic` |
| `Authentication failed (401)` | キーが誤り・無効。`:Cop key` をやり直す |
| `credit balance is too low` | Anthropic のコンソールでクレジットを購入 |
| おかしな候補が出る | `COPILOT_ANYMODEL_DUMP=/tmp/dump.txt nvim` で起動し、送ったプロンプトと生の応答を確認 |

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
