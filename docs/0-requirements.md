# Li+ Desktop 要求仕様

## purpose

複数のAIエージェントCLI（Claude Code, Codex等）を、各サービスのサブスクリプション課金枠内でそれぞれ独立に実行しつつ、人間側は単一のUIから統合的に操作・監視するデスクトップアプリケーション。

Li+言語のネイティブランタイムとして、アダプター層・タスク層・オペレーション層をUI側に内包し、CLIにはモデル層（Li+core.md）のみを渡す構成を目指す。

## premise

- 各AIエージェントは独立した子プロセスとして動作する（別プロセス、別サブスク課金）
- CLIはそれぞれのサブスクリプションIDで認証済み（Claude Code = Anthropic, Codex = OpenAI）
- GitHubがエージェント間の共通外部メモリとして機能する（issue, PR, commit）
- エージェント間の直接通信は不要（GitHubを中継点とする）
- フロントエンドはLi+を知らなくてよい — Li+の各層はアプリのコードとして実装される
- Tauri v2 + Rust バックエンド + WebView フロントエンド
- ターミナルエミュレーション: xterm.js
- PTY バックエンド: `portable-pty` クレート（ConPTY 経由）

## constraints

- ライセンス: Apache-2.0
- Windows 10+ 必須（ConPTY 依存）
- CLIのstdin/stdout/stderrを PTY 経由でインタラクティブに接続する（`tauri-plugin-shell` は使用しない）
- 各エージェントの実行状態（起動中/停止中/エラー）をUI上で明示する
- パスにスペースが含まれる環境での動作（CARGO_TARGET_DIR を空白なしパスに設定すること）
- ビルド環境に MinGW binutils（`as.exe`, `dlltool.exe`）が必要（GNU ツールチェーン使用時）
  - `~/.local/mingw64/bin` が PATH に含まれていること

## architecture

```
Li+ Desktop (Tauri app)
├── UI Layer (WebView)
│   ├── マルチペインターミナル表示（xterm.js）
│   ├── エージェント制御パネル（Start/Stop/設定）
│   └── GitHub統合ビュー（将来）
├── App Layer (Rust)
│   ├── PTY 管理（portable-pty: spawn_pty / write_pty / resize_pty / kill_pty）
│   ├── Tauri IPC（invoke/emit でフロントエンドと通信）
│   ├── Li+ アダプター層の実装（将来）
│   ├── Li+ タスク層の実装（将来）
│   └── Li+ オペレーション層の実装（将来）
├── CLI Processes（PTY 経由）
│   ├── Claude Code CLI ← Li+core.md を注入（将来）
│   ├── Codex CLI ← Li+core.md を注入（将来）
│   └── (拡張可能: 他のAI CLI)
└── External
    ├── GitHub API（issue/PR/commit = 外部メモリ）
    └── 各AIサービス（サブスク認証はCLI側が保持）
```

### Tauri IPC 設計

```
[xterm.js in WebView] <--invoke/event--> [Rust PTY (portable-pty/ConPTY)] <--PTY--> [CLI process]
```

Tauri コマンド（Rust 側に実装）:
- `spawn_pty(command, args, cols, rows, cwd?)` → PTY ID（UUID文字列）を返す
- `write_pty(id, data)` → PTY stdin に送信
- `resize_pty(id, cols, rows)` → PTY をリサイズ
- `kill_pty(id)` → PTY プロセスを終了
- `load_config()` → `AppConfig` を返す（ファイルが存在しない場合はデフォルト値）
- `save_config(config)` → `AppConfig` を JSON ファイルに保存

Tauri イベント（Rust → フロントエンド）:
- `pty-data-{id}` → PTY 出力データ（文字列）
- `pty-exit-{id}` → PTY プロセス終了通知

### 設定システム

各ペインの CLI コマンド・引数・作業ディレクトリをユーザーが自由に設定できる。

設定ファイル:
- 保存先: `AppData/Roaming/com.liplus.desktop/config.json`
- 形式: JSON

設定スキーマ:
```json
{
  "left":  { "command": "claude", "args": [], "cwd": null },
  "right": { "command": "codex",  "args": [], "cwd": null }
}
```

UI:
- 各ペインのヘッダーに `⚙` ボタンを配置
- クリックでモーダルを表示（Command / Args / Working Directory）
- Save で `save_config` を呼び出し永続化
- 設定は次回 Start 時に反映（実行中プロセスには影響しない）

## ビルド手順

### 前提条件

- Rust ツールチェーン（`rustup`）
- Node.js + npm
- MinGW binutils（`as.exe`, `dlltool.exe`）— `~/.local/mingw64/bin` が PATH に含まれていること

### パスにスペースが含まれる環境（Windows デフォルトユーザー名等）

MinGW binutils はビルド成果物のパスにスペースがあるとリンクエラーを起こす。
`src-tauri/.cargo/config.toml.example` をコピーして設定する:

```sh
cp src-tauri/.cargo/config.toml.example src-tauri/.cargo/config.toml
# 必要に応じて target-dir のパスを編集する
```

`src-tauri/.cargo/config.toml` はマシン固有のファイルであり `.gitignore` に登録済み。コミットしないこと。

### ビルド

```sh
npm install
npm run tauri build
```

## MVP status (v0.1.0-dev)

現在実装済み:
- Tauri v2 プロジェクト構造
- 2ペイン分割ターミナルUI（xterm.js）
- Start/Stop ボタンによる PTY 経由の CLI 起動（portable-pty / ConPTY）
- ドラッグによるペイン幅変更
- PTY リサイズ（xterm.js onResize → resize_pty）
- PTY 出力のストリーミング（Tauri events → xterm.js）
- PTY への入力転送（xterm.js onData → write_pty）

未実装:
- 実際のCLI（claude, codex）との接続テスト（ConPTY 上での動作検証）
- Li+core.md バンドル・注入
- GitHub統合
- Li+各層のUI側実装
- CI/CD
- エラーハンドリング・再接続

実装済み（v0.1.0-dev 追加分）:
- エージェント設定UI（コマンド・引数・作業ディレクトリの設定・永続化）
