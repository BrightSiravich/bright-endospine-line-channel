# LINE x Claude Code Channels Plugin 設計書

## 概要

LINE Messaging API を Claude Code Channels のカスタムチャネルプラグインとして実装し、LINE からローカルの Claude Code セッションを操作できるようにする。

### ゴール

LINE にメッセージを送ると、ローカルで動いている Claude Code セッションが受信・処理し、結果を LINE に返信する。

### スコープ

- LINE <-> Claude Code への双方向テキストチャットブリッジ
- Permission relay(ツール実行の承認/拒否を LINE から操作)
- Sender gating(ペアリングコード方式で特定ユーザーのみ許可)

### スコープ外

- 画像・ファイルの送受信
- グループチャット対応
- LINE リッチメニュー / Flex Message
- 本番環境デプロイ(allowlist 登録)

---

## アーキテクチャ

```
LINE App
  -> LINE Platform (Webhook POST)
    -> Cloudflare Tunnel (localhost:8788)
      -> Hono (POST /webhook)
        -> 署名検証 -> sender gating -> verdict 判定
          -> MCP notification -> Claude Code セッション
            -> line_reply tool -> Push API -> LINE App
```

### 技術スタック

| 技術 | 用途 |
|------|------|
| Bun | ランタイム |
| Hono | HTTP サーバー(Webhook 受信) |
| @modelcontextprotocol/sdk | MCP Server |
| cloudflared | ローカルトンネル |
| Web Crypto API | HMAC-SHA256 署名検証 |
| zod | スキーマ検証(MCP notification ハンドラ) |

### 公式パターンとの対応

MCP プロトコルの使い方(capabilities, notifications, tools, stdio transport)は公式 Telegram プラグインと完全に同じパターン。差異は以下の2点のみ:

- LINE は Webhook 方式のため HTTP サーバー(Hono)が必要(Telegram はポーリング)
- src/ 配下でモジュール分割(Telegram は単一ファイル)

---

## ディレクトリ構成

```
line-to-cc/
  .claude-plugin/
    plugin.json              # プラグインマニフェスト
  skills/
    configure/
      configure.md           # /line:configure (credentials 設定)
    access/
      access.md              # /line:access (ペアリング・allowlist 管理)
  src/
    server.ts                # エントリポイント: MCP Server + HTTP 起動
    webhook.ts               # Hono アプリ: LINE Webhook ハンドラ
    line-api.ts              # LINE Push API クライアント
    signature.ts             # HMAC-SHA256 署名検証
    access-control.ts        # ペアリング・sender gating
    permission.ts            # Permission relay ロジック
    types.ts                 # LINE Webhook イベント型定義
  .mcp.json                  # MCP サーバー起動設定
  .env.example               # 環境変数テンプレート
  package.json
  tsconfig.json
```

---

## プラグインマニフェスト (.claude-plugin/plugin.json)

```json
{
  "name": "line",
  "description": "LINE channel for Claude Code -- messaging bridge with built-in access control.",
  "version": "0.0.1",
  "keywords": ["line", "messaging", "channel", "mcp"]
}
```

plugin.json はプラグインのメタデータのみ。capabilities や MCP サーバー設定は別ファイル(.mcp.json, server.ts)で定義する。

---

## MCP サーバー起動設定 (.mcp.json)

```json
{
  "mcpServers": {
    "line": {
      "command": "bun",
      "args": ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"],
      "env": {
        "LINE_CHANNEL_SECRET": "${LINE_CHANNEL_SECRET}",
        "LINE_CHANNEL_ACCESS_TOKEN": "${LINE_CHANNEL_ACCESS_TOKEN}"
      }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` はプラグインのインストールディレクトリに自動展開される。`start` スクリプトは package.json で `bun install --no-summary && bun src/server.ts` を定義する。

### 環境変数の受け渡しフロー

1. ユーザーが `/line:configure` で credentials を入力
2. `~/.claude/channels/line/.env` に保存
3. Claude Code が `.mcp.json` の `env` フィールドを読み取り、サブプロセス起動時に環境変数として注入
4. server.ts 内で `process.env.LINE_CHANNEL_SECRET` / `process.env.LINE_CHANNEL_ACCESS_TOKEN` として参照

---

## Skills 定義

### /line:configure

credentials を設定するスラッシュコマンド。
- 使い方: `/line:configure` (対話形式で LINE_CHANNEL_SECRET と LINE_CHANNEL_ACCESS_TOKEN を設定)
- 保存先: `~/.claude/channels/line/.env`

### /line:access

ペアリングと allowlist を管理するスラッシュコマンド。
- `/line:access pair <code>` -- ペアリングコードを入力して完了
- `/line:access policy <pairing|allowlist|disabled>` -- アクセスモードを切替
- `/line:access list` -- 許可済みユーザー一覧
- `/line:access remove <user_id>` -- ユーザーを allowlist から削除

---

## MCP Server 設計 (src/server.ts)

### capabilities 宣言

```ts
const mcp = new Server(
  { name: 'line', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      'LINE からのメッセージは <channel source="line" user_id="U..." display_name="..."> タグで届く。',
      'ユーザーへの返信には必ず line_reply tool を使用し、正しい user_id を指定すること。',
      'メッセージ履歴へのアクセスはできない。各メッセージは独立したイベントとして届く。',
      'テキストメッセージは最大 5,000 文字。超過する場合は自動分割される。',
      'アクセス管理(ペアリング、allowlist)は CLI の /line:access スキルで行う。チャット内コマンドでは操作しない。',
    ].join('\n'),
  },
)
```

### 起動フロー

1. MCP Server を stdio transport で Claude Code に接続
2. Hono HTTP サーバーを `Bun.serve()` で port 8788、hostname `127.0.0.1` に起動
3. HTTP サーバーが受信したイベントは MCP notification として Claude Code に push

### 終了フロー

stdin が閉じた場合(Claude Code がサブプロセスを終了)、HTTP サーバーを停止してプロセスを終了する。

### tool ハンドラ登録

`line_reply` tool を Claude Code に公開する。2つのリクエストハンドラを登録:

```ts
// tool 一覧を返す(Claude Code がセッション開始時に呼び出す)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'line_reply',
    description: 'Send a reply to a LINE user',
    inputSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'LINE user ID (starts with U)' },
        text: { type: 'string', description: 'Message text' },
      },
      required: ['user_id', 'text'],
    },
  }],
}))

// tool 呼び出しを処理する
mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'line_reply') {
    await pushMessage(request.params.arguments.user_id, request.params.arguments.text)
    return { content: [{ type: 'text', text: 'Message sent.' }] }
  }
  throw new Error(`Unknown tool: ${request.params.name}`)
})
```

---

## Webhook 受信 & 署名検証 (src/webhook.ts, src/signature.ts)

### エンドポイント

`POST /webhook`

### 処理フロー

1. `x-line-signature` ヘッダー欠落チェック -> 欠落なら 401
2. リクエストボディを `c.req.text()` で生文字列のまま保持(JSON パース前に検証)
3. HMAC-SHA256 署名検証 -> 不一致なら 403
4. 200 を即座に返却(LINE 公式推奨: 非同期処理)
5. events 配列を JSON パース。空配列の場合はここで終了(Webhook URL 検証リクエスト)
6. `type: "message"` かつ `message.type: "text"` のイベントを抽出
7. `webhookEventId` で重複排除(リプレイ攻撃対策)。Map でインメモリ管理、挿入順で 1000 件超過時に古い方から削除
8. `source.userId` が allowlist にあるか確認(sender gating)
9. テキストが verdict パターンに一致 -> permission verdict として処理
10. 通常メッセージ -> `notifications/claude/channel` で Claude Code に通知

**注意**: 手順 4 で 200 を返した後、手順 5 以降は非同期で実行する。Webhook URL 検証リクエスト(events 空配列)も署名検証を通過する必要がある。

### 署名検証の実装方針

Web Crypto API の `crypto.subtle.verify` を使用。タイミングセーフ比較が内部的に行われるため安全。外部ライブラリ不要。

```ts
async function verifySignature(body: string, secret: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  )
  const sigBuf = Uint8Array.from(atob(signature), c => c.charCodeAt(0))
  return crypto.subtle.verify('HMAC', key, sigBuf, encoder.encode(body))
}
```

---

## アクセス制御 & ペアリング (src/access-control.ts)

### 3モード方式

| モード | 動作 |
|--------|------|
| pairing | 未知ユーザーにペアリングコードを発行 |
| allowlist | 許可済みユーザーのみ通過(通常運用) |
| disabled | 全メッセージ無視 |

### ペアリングフロー

1. 未知の userId からメッセージ受信
2. 6文字のランダムコードを生成 -> LINE に Push API で返信
3. Claude Code ターミナルにペアリング通知(notifications/claude/channel で表示)
4. ユーザーがターミナルでコード入力(`/line:access pair <code>`)
5. 一致 -> `~/.claude/channels/line/access.json` に永続化、モードを allowlist に切替

### ペアリングコードのセキュリティ

- 有効期限: 1時間。期限切れ後は再送が必要
- 最大再送回数: 同一 userId に対して 2 回まで(超過時は「しばらく待ってから再試行」と返信)
- 同時ペアリング: 1セッションにつき 1 ユーザーのみ。別の未知ユーザーからのメッセージはキューせず無視(pairing 中であることを LINE に返信)

### access.json 構造

```json
{
  "mode": "allowlist",
  "allowed_users": [
    { "id": "U1234...", "name": "Nishikawa", "paired_at": "2026-04-05T..." }
  ]
}
```

---

## Permission Relay (src/permission.ts)

### ハンドラ登録

Zod スキーマで `notifications/claude/channel/permission_request` を定義し、`mcp.setNotificationHandler` で登録する:

```ts
const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),     // 5文字の英小文字(l を除く a-z)
    tool_name: z.string(),      // 例: "Bash", "Write"
    description: z.string(),    // ツール呼び出しの説明
    input_preview: z.string(),  // ツール引数の JSON(200文字に切り詰め)
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const msg =
    `Claude が ${params.tool_name} を実行しようとしています:\n` +
    `${params.description}\n\n` +
    `${params.input_preview}\n\n` +
    `承認: yes ${params.request_id}\n` +
    `拒否: no ${params.request_id}`
  await pushMessage(targetUserId, msg)
})
```

### Claude Code -> LINE (承認リクエスト)

通知を受信すると、以下の情報を含むメッセージを LINE に Push する:

- `tool_name`: 実行しようとしているツール名
- `description`: ツール呼び出しの説明
- `input_preview`: ツール引数のプレビュー(200文字まで)
- `request_id`: 承認/拒否に必要な ID

### LINE -> Claude Code (ユーザー応答)

テキストが `/^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i` にマッチ -> permission verdict として処理。

`l` を除外する理由: スマホキーボードで `1`(数字) や `I`(大文字) と混同しないため。先頭・末尾の空白と `y`/`n` 省略形も許容する(モバイル入力の利便性)。

```ts
await mcp.notification({
  method: 'notifications/claude/channel/permission',
  params: {
    request_id: 'abcde',
    behavior: 'allow',  // y|yes -> 'allow', n|no -> 'deny'
  },
})
```

マッチしない場合は通常メッセージとして Claude Code に転送。

---

## LINE Push API クライアント (src/line-api.ts)

### 送信方式

Reply Token は Claude Code の処理待ちで失効するため、全て Push API を使用。

- エンドポイント: `POST https://api.line.me/v2/bot/message/push`
- 認証: `Authorization: Bearer {channel_access_token}`
- テキスト最大 5,000 文字 -> 超過時は分割送信
- 無料プラン月 200 通 -> ログで送信数カウント(警告のみ)

### line_reply tool 定義

| パラメータ | 型 | 説明 |
|-----------|------|------|
| user_id | string | LINE ユーザー ID (U で始まる) |
| text | string | メッセージ本文 |

---

## エラーハンドリング

| エラー | 対応 |
|--------|------|
| 署名検証失敗 | 403 返却、処理しない |
| x-line-signature ヘッダー欠落 | 401 返却 |
| 未許可ユーザー | 無視(pairing モード時はコード発行) |
| Push API 失敗 | stderr にログ、リトライしない |
| events 空配列(Webhook URL 検証) | 200 返却のみ |
| webhookEventId 重複 | スキップ(Set でインメモリ管理、1000件で LRU 削除) |

---

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| LINE_CHANNEL_SECRET | yes | HMAC-SHA256 署名検証用 |
| LINE_CHANNEL_ACCESS_TOKEN | yes | Push API 認証用 |
| LINE_WEBHOOK_PORT | no | デフォルト 8788 |

---

## 前提条件

| ソフトウェア | バージョン | 用途 |
|-------------|-----------|------|
| Claude Code | v2.1.80+ (確認済み: v2.1.92) | Channels 機能 |
| Bun | 最新 | ランタイム |
| cloudflared | 最新 (要インストール) | ローカルトンネル |
| tmux | - | セッション常駐 |

---

## セキュリティ考慮事項

| リスク | 対策 |
|--------|------|
| Webhook 偽装 | HMAC-SHA256 署名検証 (crypto.subtle.verify でタイミングセーフ) |
| 不正ユーザー | sender gating (userId allowlist) |
| Permission 不正承認 | request_id による one-time verification |
| リプレイ攻撃 | webhookEventId による重複排除 |
| Tunnel URL 漏洩 | Quick tunnel は一時的、Named tunnel + Access Policy 推奨 |
| リクエストボディ改ざん | 生文字列で署名検証後に JSON パース |

---

## 参考資料

- Claude Code Channels リファレンス: https://code.claude.com/docs/en/channels-reference
- Claude Code Channels ガイド: https://code.claude.com/docs/en/channels
- LINE Messaging API リファレンス: https://developers.line.biz/en/reference/messaging-api/
- LINE Webhook 署名検証: https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
- Telegram プラグインソース: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
- Cloudflare Tunnel ドキュメント: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
