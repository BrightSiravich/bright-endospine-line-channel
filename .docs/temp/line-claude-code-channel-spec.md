# LINE × Claude Code Channels カスタムプラグイン設計書

## 概要

LINE Messaging API を Claude Code Channels のカスタムチャネルプラグインとして実装し、LINE からローカルの Claude Code セッションを操作できるようにする。

### ゴール

LINEにメッセージを送ると、ローカルで動いている Claude Code セッションが受信・処理し、結果を LINE に返信する。

### スコープ

- LINE → Claude Code への双方向チャットブリッジ
- テキストメッセージの送受信
- Permission relay（ツール実行の承認/拒否を LINE から操作）
- sender gating（特定の LINE ユーザーのみ許可）

### スコープ外

- 画像・ファイルの送受信
- グループチャット対応
- LINE リッチメニュー / Flex Message
- 本番環境デプロイ（allowlist 登録）

---

## アーキテクチャ

全体の流れは LINE App → LINE Platform → Cloudflare Tunnel → LINE Channel Plugin（MCP Server）→ Claude Code Session の一直線。返信は逆方向で、Plugin から LINE Push API を直接呼び出す。

### 構成要素

**LINE App（ユーザー端末）** — ユーザーがメッセージを送受信するスマホアプリ。

**LINE Platform** — LINE のサーバー。ユーザーのメッセージイベントを Webhook として HTTPS POST する。リクエストには HMAC-SHA256 署名（x-line-signature ヘッダー）が付与される。

**Cloudflare Tunnel（cloudflared）** — ローカルマシンの localhost:8788 を外部に公開する。LINE Platform からの Webhook POST を受け取り、ローカルに中継する。Quick tunnel なら設定不要で一時 URL が発行される。

**LINE Channel Plugin（line-channel.ts）** — 今回作るもの。Bun で動く MCP サーバーで、HTTP サーバー（Webhook 受信）と MCP 通信（Claude Code との stdio 接続）の2つの役割を持つ。ポート 8788 で LINE Webhook を受信し、署名検証・sender gating を経て Claude Code セッションに通知する。Claude Code からの返信は LINE Push API で送信する。

**Claude Code Session** — tmux で常駐するローカルの Claude Code。`--dangerously-load-development-channels` フラグ付きで起動し、Plugin を MCP サブプロセスとして spawn する。

### Telegram プラグインとの設計差異

| 項目 | Telegram | LINE (本プラグイン) |
|------|----------|---------------------|
| メッセージ取得 | Bot API ポーリング (getUpdates) | Webhook (HTTPS POST) |
| 外部公開 | 不要（ローカルからポーリング） | 必要（Cloudflare Tunnel） |
| 署名検証 | Bot token ベース | HMAC-SHA256 (channel secret) |
| 返信方式 | Bot API sendMessage | Push API (`POST /v2/bot/message/push`) |
| ペアリング | pairing code → user ID | 同様のフロー（初回メッセージで pairing code 発行）|

---

## 前提条件

### 必須ソフトウェア

| ソフトウェア | バージョン | 用途 |
|-------------|-----------|------|
| Claude Code | v2.1.80+ | Channels 機能 |
| Bun | 最新 | MCP サーバーランタイム |
| cloudflared | 最新 | ローカルトンネル |
| tmux | - | セッション常駐 |

### LINE Developers Console での準備

1. LINE Developers Console にログイン
2. プロバイダー作成（既存利用可）
3. 「Messaging API」チャネルを新規作成
4. Channel Secret（Basic settings タブ）と Channel Access Token（Messaging API タブで Issue）を控える
5. Webhook URL は Cloudflare Tunnel 起動後に設定する

### 環境変数

`~/.claude/channels/line/.env` に LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN を設定する。LINE_ALLOWED_USER_IDS は初回ペアリング後に自動設定される。

---

## 実装設計

### ファイル構成

プラグインルートに `.claude-plugin/plugin.json`（マニフェスト）、`line-channel.ts`（メインサーバー）、`package.json`、`.env.example` を配置する。

### MCP Server 宣言

capabilities に `claude/channel`（チャネル登録）、`claude/channel/permission`（permission relay）、`tools`（reply tool）の3つを宣言する。instructions には「LINE からのメッセージは `<channel source="line" user_id="U..." display_name="...">` タグで届く。line_reply tool で user_id を指定して返信せよ」と記述する。

### Webhook 受信 & 署名検証

HTTP サーバーは localhost:8788 で起動し、`POST /webhook` で LINE Platform からのイベントを受信する。

署名検証は Web Crypto API の HMAC-SHA256 を使用する。channel secret をキーとしてリクエストボディのダイジェストを計算し、x-line-signature ヘッダーの値と比較する。不一致なら 403 で拒否。

受信後の処理フロー：

1. x-line-signature ヘッダーで署名検証
2. events 配列を解析し、type が message かつ message.type が text のイベントを抽出
3. source.userId が allowlist にあるか確認（sender gating）
4. Permission verdict パターン（`yes/no` + 5文字コード）に一致するか判定
5. verdict ならば `notifications/claude/channel/permission` を送信
6. 通常メッセージならば `notifications/claude/channel` で Claude Code に通知（meta に user_id と display_name を含める）

### Reply Tool（LINE Push API で返信）

Reply Token は Webhook 受信後すぐ使う必要があり、Claude Code の処理を待つと期限切れになる。そのため **Push API**（`POST /v2/bot/message/push`）を使用する。

tool 名は `line_reply`。入力は user_id（LINE ユーザー ID、U で始まる）と text（メッセージ本文、最大 5000 文字）。Claude Code がこの tool を呼び出すと、Plugin が LINE Push API を fetch で呼び出してメッセージを送信する。

### Sender Gating（ペアリング方式）

Telegram プラグインと同様の pairing code 方式を採用する。

**初回ペアリングフロー：**

1. 未知の userId からメッセージ受信
2. 6文字のペアリングコードを生成し、LINE に Push API で返信
3. Claude Code ターミナルにペアリングコード入力プロンプトを表示（チャネル通知経由）
4. ユーザーがターミナルでコードを入力
5. コード一致で userId を allowlist に追加し、`~/.claude/channels/line/access.json` に永続化

**allowlist 構造：** allowed_users 配列に id、name、paired_at を持つオブジェクトを格納する。

### Permission Relay

Claude Code がツール実行（Bash, Write 等）の承認を求めたとき、LINE にプロンプトを転送する。

**受信方向（Claude Code → LINE）：** `notifications/claude/channel/permission_request` を受け取り、tool_name、description、request_id を含むメッセージを LINE に Push する。「承認: yes xxxxx / 拒否: no xxxxx」の形式でユーザーに提示する。

**応答方向（LINE → Claude Code）：** ユーザーの返信テキストが `yes/no` + 5文字のIDパターンに一致したら、通常のチャネル通知ではなく `notifications/claude/channel/permission` として verdict を送信する。マッチしない場合は通常メッセージとして Claude Code に転送する。

---

## セットアップ手順

### Phase 1: 開発環境構築

1. プロジェクトディレクトリを作成し、`@modelcontextprotocol/sdk` と `zod` を bun add でインストール
2. line-channel.ts を上記設計に従って実装
3. .mcp.json に line サーバーのエントリを追加（command: bun, args: ./line-channel.ts）
4. `~/.claude/channels/line/.env` に LINE の credentials を設定

### Phase 2: Cloudflare Tunnel セットアップ

`cloudflared tunnel --url http://localhost:8788` で Quick tunnel を起動する。出力される URL（例: `https://xxxxx.trycloudflare.com`）の末尾に `/webhook` を付けて、LINE Developers Console の Webhook URL に設定する。Webhook の利用をオンにし、応答メッセージをオフにする。

> Quick tunnel の URL はプロセス再起動で変わる。恒久的に使う場合は Named tunnel を設定する。

### Phase 3: Claude Code セッション起動

tmux で新規セッションを作成し、`claude --dangerously-load-development-channels server:line` で Claude Code を起動する。

### Phase 4: ペアリング

1. LINE アプリで作成した Bot を友だち追加
2. 何かメッセージを送信
3. Bot からペアリングコードが返信される
4. Claude Code ターミナルでペアリングコードを入力
5. 「Paired successfully」と表示されれば完了

### Phase 5: 動作確認

1. LINE から「このディレクトリのファイルを一覧して」と送信
2. Claude Code がコマンドを実行しようとする
3. Permission prompt が LINE に届く
4. `yes xxxxx` と返信して承認
5. 実行結果が LINE に返信される

---

## セキュリティ考慮事項

### 必須対策

| リスク | 対策 |
|--------|------|
| Webhook 偽装 | HMAC-SHA256 署名検証（LINE channel secret） |
| 不正ユーザーからの操作 | sender gating（userId allowlist） |
| Permission の不正承認 | request_id による one-time verification |
| Tunnel URL の漏洩 | Quick tunnel は一時的、Named tunnel + Access Policy 推奨 |

### 推奨対策（将来）

- Cloudflare Access でトンネルに認証を追加
- allowlist を暗号化保存
- Auto-mode の制限（LINE 経由では allowedTools で実行可能ツールを制限する等）

---

## 制約事項

### Claude Code Channels の制約

- Research Preview 段階のため `--dangerously-load-development-channels` フラグが必要
- Claude Code セッションが閉じるとメッセージ受信不可（tmux で常駐が必須）
- claude.ai ログイン必須（API キー認証は非対応）
- MCP サーバーはローカルマシンで動作する必要がある

### LINE Messaging API の制約

- Push API のメッセージ数は無料プランで月 200 通（2026年4月時点、要確認）
- テキストメッセージは最大 5,000 文字
- Reply Token は短時間で失効するため Push API を使用する設計
- ポーリング API が存在しないため、外部公開エンドポイント（Tunnel）が必要

### 運用上の制約

- Quick tunnel の URL はプロセス再起動で変わる
- tmux / screen でセッション維持が必要
- マシンがスリープすると接続が切れる

---

## 参考資料

- Claude Code Channels リファレンス — https://code.claude.com/docs/en/channels-reference
- Claude Code Channels ガイド — https://code.claude.com/docs/en/channels
- Telegram プラグインソース — https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
- LINE Messaging API リファレンス — https://developers.line.biz/en/reference/messaging-api/
- LINE Webhook 署名検証 — https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- Cloudflare Tunnel ドキュメント — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
