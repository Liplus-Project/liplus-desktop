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

## constraints

- ライセンス: MIT（アプリ本体）、バンドルするLi+コンポーネントはApache-2.0帰属
- Windows対応必須（主要開発環境）、macOS/Linux対応は将来
- CLIのstdin/stdout/stderrを正しくパイプし、インタラクティブ操作を可能にする
- 各エージェントの実行状態（起動中/停止中/エラー）をUI上で明示する
- パスにスペースが含まれる環境での動作（CARGO_TARGET_DIR回避策が必要）

## architecture

```
Li+ Desktop (Tauri app)
├── UI Layer (WebView)
│   ├── マルチペインターミナル表示
│   ├── エージェント制御パネル（Start/Stop/設定）
│   └── GitHub統合ビュー（将来）
├── App Layer (Rust)
│   ├── 子プロセス管理（CLI spawn/kill/IO pipe）
│   ├── Li+ アダプター層の実装
│   ├── Li+ タスク層の実装
│   └── Li+ オペレーション層の実装
├── CLI Processes
│   ├── Claude Code CLI ← Li+core.md を注入
│   ├── Codex CLI ← Li+core.md を注入
│   └── (拡張可能: 他のAI CLI)
└── External
    ├── GitHub API（issue/PR/commit = 外部メモリ）
    └── 各AIサービス（サブスク認証はCLI側が保持）
```

## MVP status (v0.1.0-dev)

現在実装済み:
- Tauri v2プロジェクト構造
- 2ペイン分割ターミナルUI（xterm.js）
- Start/Stopボタンによるcmd経由のCLI起動
- ドラッグによるペイン幅変更
- ビルド・インストーラー生成（.exe, .msi）

未実装:
- 実際のCLI（claude, codex）との接続テスト
- stdin入力のインタラクティブ対応
- エージェント設定UI
- Li+core.md バンドル・注入
- GitHub統合
- Li+各層のUI側実装
- CI/CD
- エラーハンドリング・再接続
