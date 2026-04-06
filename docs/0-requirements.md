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
- `spawn_pty(command, args, cols, rows)` → PTY ID（UUID文字列）を返す
- `write_pty(id, data)` → PTY stdin に送信
- `resize_pty(id, cols, rows)` → PTY をリサイズ
- `kill_pty(id)` → PTY プロセスを終了

Tauri イベント（Rust → フロントエンド）:
- `pty-data-{id}` → PTY 出力データ（文字列）
- `pty-exit-{id}` → PTY プロセス終了通知

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
- エージェント設定UI
- Li+core.md バンドル・注入
- GitHub統合
- Li+各層のUI側実装
- CI/CD
- エラーハンドリング・再接続
