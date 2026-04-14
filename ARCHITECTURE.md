# line-to-cc アーキテクチャ解説

LINE Messaging API を **Claude Code の Custom Channel Plugin** として実装し、LINE から直接ローカルの Claude Code セッションを操作できるようにしたプロジェクトの技術解説です。

---

## 全体像

```mermaid
flowchart TB
    subgraph LINE["LINE Platform"]
        LApp["LINE アプリ"]
        LPF["LINE Platform\n(Webhook / Push API)"]
        LApp <-->|メッセージ| LPF
    end

    subgraph Local["ローカルマシン (開発者 PC)"]
        subgraph Process["server.ts プロセス"]
            MCP["MCP Server\n(stdio)"]
            HTTP["Hono HTTP Server\nlocalhost:8788"]
            AC["Access Control\n(pairing / allowlist)"]
            PR["Permission Relay\n(Flex Message builder)"]
            MCP --- HTTP
            HTTP --- AC
            MCP --- PR
        end
        CF["cloudflared\nQuick Tunnel"]
        CC["Claude Code"]
        CC <-->|"JSON-RPC\n(stdio)"| MCP
        HTTP <-->|"localhost"| CF
    end

    LPF -->|"POST /webhook\n(HTTPS)"| CF
    PR -->|"Push API"| LPF
```

### コンポーネント一覧

| コンポーネント | 技術 | 役割 |
|---|---|---|
| **MCP Server** | `@modelcontextprotocol/sdk` | Claude Code との通信ブリッジ |
| **HTTP Server** | Hono on Bun | LINE Webhook の受信 |
| **cloudflared** | Quick Tunnel | localhost を HTTPS 公開 |
| **Access Control** | in-memory + JSON | ペアリング・sender gating |
| **Permission Relay** | Flex Message | Claude の許可要求を LINE に転送 |

---

## 起動フロー

```mermaid
sequenceDiagram
    participant Dev as 開発者ターミナル
    participant CC as Claude Code
    participant Srv as server.ts
    participant CF as cloudflared
    participant LINE as LINE Platform

    Dev->>CC: claude --dangerously-load-development-channels server:line
    CC->>Srv: 子プロセスとして起動 (stdio)
    Srv->>CC: MCP connect (stdio transport)
    Note over Srv: HTTP Server 起動 (localhost:8788)
    Srv->>CF: spawn cloudflared tunnel
    CF-->>Srv: https://xxxx.trycloudflare.com (stdout/stderr 監視)
    Srv->>LINE: PUT /webhook (Webhook URL を自動設定)
    LINE-->>Srv: 200 OK (疎通確認込み)
    Srv->>LINE: GET /webhook (URL を検証)
    Srv->>LINE: POST /webhook/test (接続テスト)
    LINE-->>Srv: 200 OK
    Srv->>CC: MCP notification "LINE channel ready"
    Note over Dev: チャット画面に "LINE channel ready" 表示
```

> **設計ポイント**: MCP 接続を先に確立してから tunnel をセットアップすることで、「tunnel 完了」通知をチャットに届けられる。

---

## メッセージ受信フロー

LINE からメッセージが届いてから Claude Code のチャットに表示されるまでの流れです。

```mermaid
sequenceDiagram
    participant LApp as LINE アプリ
    participant LINE as LINE Platform
    participant Hono as Hono (/webhook)
    participant AC as Access Control
    participant MCP as MCP Server

    LApp->>LINE: メッセージ送信
    LINE->>Hono: POST /webhook\n(x-line-signature ヘッダー付き)
    Hono->>Hono: HMAC-SHA256 署名検証
    Hono-->>LINE: 200 OK (即時返却)

    Note over Hono: queueMicrotask で非同期処理

    Hono->>Hono: webhookEventId で重複排除
    Hono->>AC: isAllowed(userId)?

    alt 未登録ユーザー (pairing モード)
        AC-->>Hono: false
        Hono->>LINE: Push "ペアリングコード: xxxxxx"
        Hono->>MCP: notification (ペアリング通知)
    else 許可ユーザー
        AC-->>Hono: true
        Hono->>MCP: notification\n"notifications/claude/channel"
        MCP->>MCP: Claude Code のチャットに表示
    end
```

### 即時 200 返却の理由

```
LINE の公式推奨: Webhook 受信から 1 秒以内に 200 を返す
→ queueMicrotask() で処理を非同期に分離
→ HTTP レイヤーは検証のみ行いレスポンスを返す
→ イベント処理は次のマイクロタスクキューで実行
```

---

## MCP Protocol の活用

このプロジェクトの核心は Claude Code の **Custom Channel 機能** を MCP で実装している点です。

```mermaid
flowchart LR
    subgraph CC["Claude Code"]
        Chat["チャット UI"]
        PM["Permission Manager"]
    end

    subgraph Srv["server.ts (MCP Server)"]
        Tools["MCP Tools\nline_reply\nline_verify_pairing"]
        Notif["MCP Notifications\nclaude/channel\nclaude/channel/permission"]
    end

    subgraph LINE["LINE"]
        User["ユーザー"]
        Flex["Flex Message\n(Permission Card)"]
    end

    User -->|"テキスト"| Notif
    Notif -->|"notifications/claude/channel"| Chat
    Chat -->|"CallTool: line_reply"| Tools
    Tools -->|"Push API"| User

    PM -->|"notifications/claude/channel/permission_request"| Notif
    Notif -->|"Flex Message"| Flex
    Flex -->|"yes / no"| Notif
    Notif -->|"notifications/claude/channel/permission"| PM
```

### MCP メッセージ一覧

| メッセージ | 方向 | 用途 |
|---|---|---|
| `notifications/claude/channel` | server → Claude Code | LINE メッセージをチャットに届ける |
| `notifications/claude/channel/permission_request` | Claude Code → server | ツール実行の許可要求 |
| `notifications/claude/channel/permission` | server → Claude Code | ユーザーの yes/no 判定を返す |
| `CallTool: line_reply` | Claude Code → server | Claude の返信を LINE に Push |
| `CallTool: line_verify_pairing` | Claude Code → server | ペアリングコードを承認 |

> **ポイント**: `notifications/claude/channel` は Claude Code 独自の拡張。  
> `capabilities.experimental['claude/channel']` として capability を宣言することで Claude Code に認識させる。

---

## Permission Relay フロー

Claude Code が危険なツール実行の許可を求めたとき、それを LINE に転送してモバイルから承認できます。

```mermaid
sequenceDiagram
    participant CC as Claude Code
    participant Srv as server.ts
    participant LINE as LINE アプリ

    CC->>Srv: MCP notification\npermission_request\n{request_id, tool_name, description}
    Srv->>Srv: lastReplyTo (最後の送信先) を取得
    Srv->>LINE: Push Flex Message\n(Permission Card)

    Note over LINE: Allow / Deny ボタン表示
    Note over LINE: または "yes" / "no" テキスト入力

    LINE->>Srv: POST /webhook "yes"
    Srv->>Srv: parseVerdict("yes", lastPendingRequestId)
    Srv->>CC: MCP notification\nclaude/channel/permission\n{request_id, behavior: "allow"}
    CC->>CC: ツール実行を継続
```

### Verdict パース仕様

```
"yes abcde"   → request_id 明示 (5文字コード)
"no"          → bare verdict (lastPendingRequestId を使用)
"y"           → "yes" の短縮形
```

> `'l'` を除いた小文字 a-z 5文字がコード形式。モバイルキーボードで `l` が `1` や `I` に見えるのを避けるため。

---

## ペアリングフロー

初回ユーザーを安全に追加する仕組みです。

```mermaid
sequenceDiagram
    participant LUser as LINEユーザー
    participant LINE as LINE Platform
    participant Srv as server.ts
    participant Dev as 開発者 (Claude Code)

    LUser->>LINE: 何かメッセージ送信
    LINE->>Srv: POST /webhook
    Srv->>Srv: isAllowed(userId) → false
    Srv->>Srv: startPairing(userId)\n6文字コード生成
    Srv->>LINE: Push "ペアリングコード: ab3x9z"
    Srv->>Dev: MCP notification\n(ターミナルに通知)

    Dev->>Dev: /line:access pair ab3x9z
    Dev->>Srv: CallTool: line_verify_pairing {code: "ab3x9z"}
    Srv->>Srv: verifyPairing(code)\nallowed_users に追加
    Srv->>Srv: ~/.claude/channels/line/access.json に保存
    Srv->>LINE: Push "ペアリング完了!"
    Srv-->>Dev: "Paired successfully with user Uxxxx"
```

### アクセスモード

| モード | 動作 |
|---|---|
| `pairing` | 初回メッセージでペアリングコードを発行 (デフォルト) |
| `allowlist` | ペアリング済みユーザーのみ許可 |
| `disabled` | 全員ブロック |

---

## セキュリティ設計

```mermaid
flowchart TD
    WH["POST /webhook"] --> SIG{"署名検証\nHMAC-SHA256\n(timing-safe)"}
    SIG -->|"不一致"| R403["403 Forbidden"]
    SIG -->|"一致"| DEDUP{"重複チェック\nwebhookEventId"}
    DEDUP -->|"重複"| DROP["スキップ"]
    DEDUP -->|"新規"| AC{"アクセス制御\nisAllowed(userId)"}
    AC -->|"NG"| PAIR["ペアリング or 無視"]
    AC -->|"OK"| PROC["イベント処理"]
```

| 対策 | 実装 |
|---|---|
| **署名検証** | `crypto.subtle.verify` (WebCrypto API, timing-safe) |
| **Raw body 検証** | JSON parse 前に生バイト列で検証 |
| **Replay 攻撃対策** | `webhookEventId` で重複排除 (最大 1000件 in-memory) |
| **ネットワーク分離** | HTTP サーバーは `127.0.0.1` のみバインド |
| **プロセス分離** | cloudflared 起動時に既存プロセスを kill してポート競合防止 |

---

## cloudflared Quick Tunnel の仕組み

固定ドメインや認証なしで localhost を HTTPS 公開できる Cloudflare の無料機能を活用しています。

```mermaid
sequenceDiagram
    participant Srv as server.ts
    participant CF as cloudflared プロセス
    participant CFN as Cloudflare Network
    participant LINE as LINE Platform

    Srv->>CF: spawn('cloudflared', ['tunnel', '--url', 'http://localhost:8788'])
    CF->>CFN: TLS トンネル確立
    CFN-->>CF: https://xxxx.trycloudflare.com 割り当て
    CF->>CF: stdout/stderr に URL を出力
    Srv->>Srv: stdout/stderr を監視\n正規表現でURL抽出
    Srv->>LINE: PUT /v2/bot/channel/webhook/endpoint\n{"webhookEndpointUrl": "https://xxxx.trycloudflare.com/webhook"}
    LINE-->>Srv: 200 OK
    Note over Srv,LINE: 以後 LINE は tunnel 経由で POST
```

> **注意**: Quick Tunnel の URL はプロセス再起動ごとに変わる。  
> ただし LINE Webhook URL の自動更新で運用コストはゼロ。

---

## ファイル構成

```
src/
├── server.ts          # Orchestrator: MCP + HTTP + tunnel 起動・全配線
├── webhook.ts         # Hono: 署名検証・重複排除・イベントルーティング
├── line-api.ts        # LINE API クライアント: push・webhook設定
├── signature.ts       # HMAC-SHA256 署名検証 (WebCrypto)
├── access-control.ts  # ペアリング・sender gating・allowlist 管理
├── permission.ts      # Verdict パース + Flex Message ビルダー
├── tunnel.ts          # cloudflared spawn + URL 抽出
└── types.ts           # LINE Webhook イベント型定義・型ガード
```

---

## Tech Stack

| 技術 | 選定理由 |
|---|---|
| **Bun** | 高速な起動・組み込みテストランナー・Web API 互換 |
| **Hono** | 軽量・型安全・Bun ネイティブ対応 |
| **@modelcontextprotocol/sdk** | Claude Code との通信に必須 |
| **cloudflared** | 認証不要・無料・自動 HTTPS |
| **WebCrypto API** | timing-safe な署名検証・Node.js 依存なし |
