# Li+ Desktop 要求仕様

## purpose

複数のAIエージェントCLI（Claude Code, Codex, Gemini CLI等）を、各サービスのサブスクリプション課金枠内でそれぞれ独立に実行しつつ、人間側は単一のUIから統合的に操作・監視するデスクトップアプリケーション。

Li+言語のネイティブランタイムとして、アダプター層・タスク層・オペレーション層をUI側に内包し、CLIにはモデル層（Li+core.md）のみを渡す構成を目指す。

## premise

### コアモデル

- 各AIエージェントは独立した子プロセス（別プロセス、別サブスク課金枠）
- CLIはそれぞれのサブスクリプションIDで認証済み（Claude Code = Anthropic, Codex = OpenAI, Gemini CLI = Google）
- エージェント間の直接通信は不要 — GitHubが共通外部メモリ（issue, PR, commit）
- フロントエンドはLi+を知らなくてよい — Li+の各層はアプリのコードとして実装される
- UIの基本形はClaude Desktop / Codex Desktopに倣う（ターミナルベース）

### 対応エンジン

初期対応:
- Claude Code CLI (Anthropic)
- Codex CLI (OpenAI)
- Gemini CLI (Google)

エンジン切り替え = CLI起動コマンドの切り替えで対応。
起動コマンドはユーザーが設定画面で自由にカスタマイズ可能。
新しいAI CLIも設定追加だけで対応できる拡張性。

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
  ├── Gemini CLI ← モデル層（Li+core.md）のみ
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
   - Claude Code, Codex, Gemini CLIはそれぞれサブスク課金で独立動作する
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
- Windows + Linux対応必須。macOSは検証環境がないため優先度低
- CLIのstdin/stdout/stderrを正しくパイプし、インタラクティブ操作を可能にする
- 各エージェントの実行状態（起動中/停止中/エラー）をUI上で明示する
- パスにスペースが含まれる環境での動作（CARGO_TARGET_DIR回避策が必要 — MinGWのdlltool/asがスペース入りパスを処理できない）
- ペイン数は固定2から開始、将来的に可変ペイン対応

## 配信形態

### デュアルモードアーキテクチャ
フロントエンド（Web UI）は共通。バックエンド（Rust）の配信方法で2モードを提供:

1. **デスクトップモード** (Windows向け)
   - Tauri v2: RustバックエンドがWebViewにフロントエンドを表示
   - インストーラー配布（.exe, .msi）

2. **Webモード** (Linux向け / クロスプラットフォーム)
   - 同じRustバックエンドをHTTPサーバー + WebSocketで公開
   - フロントエンドをブラウザで開く（localhost）
   - Tauri不要、Rustバイナリ単体で動作

共通部分:
- フロントエンド: 同一のTypeScript + xterm.js コード
- バックエンドロジック: 同一のRustコード（子プロセス管理、設定、暗号化）
- 差分: Tauri APIの呼び出し部分のみ抽象化が必要

## 設定機能

### エージェント設定
- 各CLIの起動コマンドをユーザーがカスタマイズ可能
  - 実行パス、引数、作業ディレクトリ、環境変数
- エンジン追加 = 設定に起動コマンドを追加するだけ
- エンジン切り替え = CLI子プロセスの再起動（多少の遅延は許容）

### APIキー管理
- APIキーの暗号化保存場所を提供
- OS標準のキーストア連携が理想（Windows Credential Manager, Linux Secret Service）
- 平文での設定ファイル保存は禁止

### ユーザープロフィール
- ユーザー名、使用言語、好みの設定を保持
- Li+のWorkspace Language Contractに対応（base language, project language）

### Character Instance設定
- Li+のCharacter_Instance（名前、コンテキスト、表現スタイル）をUI上で編集可能
- CLIに渡すLi+core.mdへの反映メカニズム

## 拡張機能

### MCP対応
- MCPサーバーとの接続をサポート
- スキル、プラグインは後回し — まずMCPプロトコル基盤のみ

### 外部ツール連携
- VS Codeを外部エディタとして起動可能（Claude Desktop, Codexと同様の選択メニュー）
- プレビュー用途、コード編集用途
- 設定で外部ツールのパスをカスタマイズ可能

### 内蔵ターミナル
- AIエージェントペインとは別に、ユーザー用の汎用ターミナルペインを提供
- git操作、ファイル確認、ビルド実行などの補助作業用

### 認証
- ユーザー認証は各CLI任せ（Li+ Desktopは介入しない）
- CLI側のログインフロー（OAuth等）はターミナルペイン内で完結

## architecture

```
Li+ Desktop
├── Frontend (共通 / TypeScript + Vite)
│   ├── マルチペインターミナル表示 (xterm.js + WebSocket)
│   │   ├── AIエージェントペイン（Claude Code / Codex / Gemini）
│   │   └── ユーザーターミナルペイン（汎用シェル）
│   ├── エージェント制御パネル（Start/Stop/切り替え）
│   ├── 設定画面
│   │   ├── エージェント設定（CLI起動コマンド）
│   │   ├── APIキー管理（暗号化保存）
│   │   ├── ユーザープロフィール
│   │   ├── Character Instance設定
│   │   └── 外部ツール設定（VS Code等のパス）
│   ├── ペインの動的追加・削除（将来）
│   ├── GitHub統合ビュー（将来）
│   └── バックエンド通信の抽象化層（Tauri API / WebSocket 切り替え）
│
├── Backend (共通 / Rust)
│   ├── 子プロセス管理（CLI spawn/kill/IO pipe）
│   ├── 設定の永続化（暗号化対応）
│   ├── キーストア連携（OS標準）
│   ├── MCP クライアント（将来）
│   ├── 外部ツール起動（VS Code等）
│   ├── Li+ アダプター層の実装（将来）
│   ├── Li+ タスク層の実装（将来）
│   └── Li+ オペレーション層の実装（将来）
│
├── 配信モード
│   ├── Desktop: Tauri v2 (WebView) — Windows
│   └── Web: HTTP + WebSocket サーバー — Linux / クロスプラットフォーム
│
├── CLI Processes (子プロセス)
│   ├── Claude Code CLI ← Li+core.md を注入
│   ├── Codex CLI ← Li+core.md を注入
│   ├── Gemini CLI ← Li+core.md を注入
│   └── (設定追加で拡張可能)
│
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
- 実際のCLI（claude, codex, gemini）との接続テスト
- PTY対応（色付き出力、カーソル制御）
- エージェント設定UI（起動コマンドのカスタマイズ）
- APIキー暗号化保存
- ユーザープロフィール設定
- Character Instance設定UI
- 設定の永続化
- Li+core.md バンドル・注入メカニズム
- MCP対応
- 外部ツール連携（VS Code起動等）
- ユーザー用汎用ターミナルペイン
- GitHub統合
- Li+各層のUI側実装
- CI/CD（GitHub Actions）
- エラーハンドリング・プロセス再起動
- Webモード（HTTP + WebSocket）
- Li+config.md / CLAUDE.md（このリポジトリ用）
