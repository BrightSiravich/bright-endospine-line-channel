# line-to-cc

LINE Messaging API を Claude Code Channels のカスタムチャネルプラグインとして実装。LINE からローカルの Claude Code セッションを操作できる。

## Features

- LINE <-> Claude Code の双方向テキストチャット
- Permission relay (ツール実行の承認/拒否を LINE の Flex Message ボタンで操作)
- Sender gating (ペアリングコード方式で特定ユーザーのみ許可)
- cloudflared トンネル自動起動 + Webhook URL 自動設定 + 疎通テスト

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) v2.1.80+
- [Bun](https://bun.sh/) latest
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`)

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/elchika-inc/line-to-cc.git
cd line-to-cc
bun install
```

### 2. LINE Developers Console

1. [LINE Developers Console](https://developers.line.biz/) にログイン
2. プロバイダー作成 (既存利用可)
3. 「Messaging API」チャネルを新規作成
4. **Channel Secret** (Basic settings タブ) と **Channel Access Token** (Messaging API タブで Issue) を控える

### 3. Credentials

```bash
cp .env.example .env
```

`.env` を編集して Channel Secret と Channel Access Token を設定:

```
LINE_CHANNEL_SECRET=your_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token
```

### 4. Start

```bash
claude --dangerously-load-development-channels server:line
```

起動すると自動的に:
1. HTTP サーバー (port 8788) が起動
2. cloudflared トンネルが起動
3. LINE の Webhook URL が自動設定
4. 疎通テストが実行
5. `LINE channel ready` が通知される

### 5. Pairing

1. LINE アプリで Bot を友だち追加
2. 何かメッセージを送信
3. ペアリングコードが LINE に返信される
4. Claude Code セッションで `line_verify_pairing` tool を使ってコードを入力

## Architecture

```
LINE App
  -> LINE Platform (Webhook POST)
    -> Cloudflare Tunnel (localhost:8788)
      -> Hono (POST /webhook)
        -> HMAC-SHA256 署名検証 -> sender gating -> verdict 判定
          -> MCP notification -> Claude Code セッション
            -> line_reply tool -> Push API -> LINE App
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `line_reply` | LINE ユーザーにメッセージを送信 |
| `line_verify_pairing` | ペアリングコードを検証してユーザーを承認 |

## Permission Relay

Claude Code がツール実行の承認を求めると、LINE に Flex Message カードが届く。
カード内の「Allow」「Deny」ボタンをタップするか、`yes` / `no` とテキスト入力で応答できる。

> Note: `--permission-mode default` で起動した場合に機能する。`bypassPermissions` モードでは発火しない。

## Project Structure

```
src/
  server.ts          # MCP Server + HTTP + tunnel 起動
  webhook.ts         # Hono Webhook ハンドラ
  line-api.ts        # LINE Push API クライアント
  signature.ts       # HMAC-SHA256 署名検証
  access-control.ts  # ペアリング・sender gating
  permission.ts      # Permission relay (Flex Message)
  tunnel.ts          # cloudflared 自動起動
  types.ts           # LINE Webhook 型定義
tests/               # Bun テスト (46 tests)
skills/              # /line:configure, /line:access
```

## Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `LINE_CHANNEL_SECRET` | Yes | HMAC-SHA256 署名検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | Yes | Push API / Webhook API 認証 |
| `LINE_WEBHOOK_PORT` | No | HTTP サーバーポート (default: 8788) |

## Tests

```bash
bun test
```

## Limitations

- Claude Code Channels は Research Preview (要 `--dangerously-load-development-channels`)
- LINE 無料プランは月 200 通
- Quick tunnel の URL はプロセス再起動で変わる (自動再設定される)
- テキスト・画像対応 (ファイル・動画・音声・スタンプ非対応)

## Image handling

Inbound image messages are fetched via the LINE Content API
(`api-data.line.me/v2/bot/message/{messageId}/content`) and persisted to
`<repo>/.images/<webhookEventId>.<ext>`. Claude reads the file with its `Read`
tool; the path is forwarded as a `notifications/claude/channel` MCP
notification of the form `[Image received: <absolute path>]`.

| Aspect | V1 policy |
|---|---|
| Supported MIME | `image/jpeg`, `image/png`, `image/gif`, `image/webp` |
| Unsupported MIME | Logged + dropped (no `.bin` fallback) |
| External `contentProvider` | Rejected at the type guard (SSRF defense) |
| Storage location | `<repo>/.images/` — gitignored, mode 0700, files 0600 |
| Filename source | Validated `webhookEventId` (charset `[A-Za-z0-9_-]`, ≤128 chars) |
| Cleanup | Manual (`rm`) — automatic cleanup is a V2 task |
| Outbound images | Not supported — `line_reply` stays text-only |
| Sender gating | Same as text — only allowlisted users' images are fetched |

`.images/` MUST NOT be committed. The directory is in `.gitignore` and
contents may include OR schedules with patient PII.

## License

MIT
