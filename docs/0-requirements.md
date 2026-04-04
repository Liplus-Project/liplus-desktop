# Li+ Desktop 要求仕様

## purpose

複数のAIエージェントCLI（Claude Code, Codex等）を、各サービスのサブスクリプション課金枠内でそれぞれ独立に実行しつつ、人間側は単一のUIから統合的に操作・監視するデスクトップアプリケーション。

Li+言語のネイティブランタイムとして、アダプター層・タスク層・オペレーション層をUI側に内包し、CLIにはモデル層（Li+core.md）のみを渡す構成を目指す。

## premise

### コアモデル

- 各AIエージェントは独立した子プロセス（別プロセス、別サブスク課金枠）
- CLIはそれぞれのサブスクリプションIDで認証済み（Claude Code = Anthropic Max/Pro, Codex = OpenAI Pro/Plus）
- エージェント間の直接通信は不要 — GitHubが共通外部メモリ（issue, PR, commit）
- フロントエンドはLi+を知らなくてよい — Li+の各層はアプリのコードとして実装される

### Li+レイヤー配置

現在のテキストベースLi+:
```
CLAUDE.md / AGENTS.md (アダプター層) → フック → CLI → モデル
```

Li+ Desktop完成形:
```
Li+ Desktop (アダプター層 + タスク層 + オペレーション層)
  ├── Claude Code CLI ← モデル層（Li+core.md）のみ
  ├── Codex CLI ← モデル層（Li+core.md）のみ
  └── GitHub API ← 外部メモリ + 判断ログ
```

この構成により:
- CLAUDE.md / AGENTS.md へのテキスト注入が不要になる
- フックスクリプトが不要になる
- ブートストラップが不要になる（アプリインストール = Li+導入）
- Li+のルールがコードとして検証可能になる

### 設計根拠（対話からの蒸留）

1. **なぜマルチAI CLI統合が必要か**
   - Cursorのようなエディタ製品はサブスク内APIで動き、BYOK廃止の流れ
   - Claude CodeとCodexはそれぞれサブスク課金で独立動作する
   - 一つのUIで複数CLIを管理する既存ツールがない

2. **なぜTauriか**
   - Electronより軽量、配布サイズが小さい
   - Rustバックエンド — 子プロセス管理に適している
   - WebView内でxterm.jsがそのまま使える
   - MinGWツールチェーンでWindows上のビルドが可能

3. **なぜCLIラッパーか**
   - Claude DesktopもCodexも内部的にはCLI
   - 子プロセスとしてspawnしてstdin/stdout/stderrをパイプするだけ
   - 各CLIの認証・サブスク管理はCLI側が保持 — アプリ側は介入しない

4. **なぜGitHub中継か**
   - issueに判断を外部化すれば、モデルを跨いでもコンテキストが残る
   - セッション断裂をGitHubが吸収する
   - Li+の既存のissue/PR/commitフローがそのまま使える

### 技術スタック

- デスクトップフレームワーク: Tauri v2
- バックエンド: Rust
- フロントエンド: TypeScript + Vite
- ターミナルエミュレーション: xterm.js + @xterm/addon-fit
- ビルドツールチェーン: Rust stable (x86_64-pc-windows-gnu) + MinGW 14.2.0
- パッケージマネージャ: npm

## constraints

- ライセンス: MIT（アプリ本体）、バンドルするLi+コンポーネントはApache-2.0帰属（NOTICEファイルで明示）
- Windows対応必須（主要開発環境）、macOS/Linux対応は将来
- CLIのstdin/stdout/stderrを正しくパイプし、インタラクティブ操作を可能にする
- 各エージェントの実行状態（起動中/停止中/エラー）をUI上で明示する
- パスにスペースが含まれる環境での動作（CARGO_TARGET_DIR回避策が必要 — MinGWのdlltool/asがスペース入りパスを処理できない）
- ペイン数は固定2から開始、将来的に可変ペイン対応

## architecture

```
Li+ Desktop (Tauri app)
├── UI Layer (WebView / TypeScript)
│   ├── マルチペインターミナル表示 (xterm.js)
│   ├── エージェント制御パネル（Start/Stop/設定）
│   ├── ペインの動的追加・削除（将来）
│   └── GitHub統合ビュー（将来）
├── App Layer (Rust / Tauri)
│   ├── 子プロセス管理（CLI spawn/kill/IO pipe）
│   ├── エージェント設定の永続化
│   ├── Li+ アダプター層の実装（将来）
│   ├── Li+ タスク層の実装（将来）
│   └── Li+ オペレーション層の実装（将来）
├── CLI Processes (子プロセス)
│   ├── Claude Code CLI ← Li+core.md を注入
│   ├── Codex CLI ← Li+core.md を注入
│   └── (拡張可能: 他のAI CLI)
└── External
    ├── GitHub API（issue/PR/commit = 外部メモリ + 判断ログ）
    └── 各AIサービス（サブスク認証はCLI側が保持）
```

## 現在の実装状態

### 実装済み (v0.1.0-dev)
- Tauri v2プロジェクト構造
- 2ペイン分割ターミナルUI（xterm.js + FitAddon）
- Start/Stopボタンによるcmd経由のCLI起動
- ドラッグによるペイン幅変更
- Tauri shell pluginによる子プロセス管理（spawn/kill/stdin write）
- ビルド・インストーラー生成（.exe, .msi）
- NOTICE（Apache-2.0帰属）
- 要求仕様書（docs/0-requirements.md）

### 未実装
- 実際のCLI（claude, codex）との接続テスト
- PTY対応（色付き出力、カーソル制御）
- エージェント設定UI（CLIパス・引数・作業ディレクトリ）
- 設定の永続化
- Li+core.md バンドル・注入メカニズム
- GitHub統合
- Li+各層のUI側実装
- CI/CD（GitHub Actions）
- エラーハンドリング・プロセス再起動
- Li+config.md / CLAUDE.md（このリポジトリ用）
