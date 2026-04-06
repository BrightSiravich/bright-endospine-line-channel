# LINE x Claude Code Channels Plugin 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LINE Messaging API を Claude Code Channels のカスタムチャネルプラグインとして実装し、LINE から Claude Code セッションを操作できるようにする。

**Architecture:** Hono HTTP サーバーで LINE Webhook を受信し、MCP Server 経由で Claude Code セッションに通知する。返信は `line_reply` tool で Push API を呼び出す。モジュール分割構成(src/ 配下)。

**Tech Stack:** Bun, Hono, @modelcontextprotocol/sdk, zod, Web Crypto API

---

## ファイル構成

| ファイル | 責務 |
|---------|------|
| `package.json` | 依存関係・スクリプト定義 |
| `tsconfig.json` | TypeScript 設定 |
| `.env.example` | 環境変数テンプレート |
| `.claude-plugin/plugin.json` | プラグインマニフェスト |
| `.mcp.json` | MCP サーバー起動設定 |
| `src/types.ts` | LINE Webhook イベント型定義 |
| `src/signature.ts` | HMAC-SHA256 署名検証 |
| `src/line-api.ts` | LINE Push API クライアント |
| `src/access-control.ts` | ペアリング・sender gating |
| `src/permission.ts` | Permission relay ロジック |
| `src/webhook.ts` | Hono アプリ: Webhook ハンドラ |
| `src/server.ts` | エントリポイント: MCP Server + HTTP 起動 |
| `skills/configure/configure.md` | /line:configure スキル |
| `skills/access/access.md` | /line:access スキル |
| `tests/signature.test.ts` | 署名検証テスト |
| `tests/line-api.test.ts` | Push API クライアントテスト |
| `tests/access-control.test.ts` | アクセス制御テスト |
| `tests/permission.test.ts` | Permission relay テスト |
| `tests/webhook.test.ts` | Webhook ハンドラテスト |

---

### Task 1: プロジェクトスキャフォールド

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `.claude-plugin/plugin.json`
- Create: `.mcp.json`

- [ ] **Step 1: git リポジトリ初期化**

```bash
cd /Users/nishikawa/projects/naoto24kawa/line-to-cc
git init
```

- [ ] **Step 2: package.json 作成**

```json
{
  "name": "claude-channel-line",
  "version": "0.0.1",
  "license": "MIT",
  "type": "module",
  "bin": "./src/server.ts",
  "scripts": {
    "start": "bun install --no-summary && bun src/server.ts",
    "dev": "bun --watch src/server.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "hono": "^4.0.0",
    "zod": "^3.23.0"
  }
}
```

- [ ] **Step 3: tsconfig.json 作成**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 4: .env.example 作成**

```
LINE_CHANNEL_SECRET=your_channel_secret_here
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token_here
# LINE_WEBHOOK_PORT=8788
```

- [ ] **Step 5: .claude-plugin/plugin.json 作成**

```json
{
  "name": "line",
  "description": "LINE channel for Claude Code -- messaging bridge with built-in access control.",
  "version": "0.0.1",
  "keywords": ["line", "messaging", "channel", "mcp"]
}
```

- [ ] **Step 6: .mcp.json 作成**

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

- [ ] **Step 7: 依存関係インストール**

```bash
bun install
```

- [ ] **Step 8: .gitignore 作成**

```
node_modules/
dist/
.env
```

- [ ] **Step 9: コミット**

```bash
git add package.json tsconfig.json .env.example .claude-plugin/plugin.json .mcp.json .gitignore bun.lock
git commit -m "feat: scaffold project with plugin manifest and MCP config"
```

---

### Task 2: LINE Webhook 型定義

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: src/types.ts 作成**

```ts
export interface LineWebhookBody {
  destination: string
  events: LineEvent[]
}

export interface LineEvent {
  type: string
  webhookEventId: string
  timestamp: number
  source: LineSource
  replyToken?: string
  message?: LineMessage
  deliveryContext?: {
    isRedelivery: boolean
  }
}

export interface LineSource {
  type: 'user' | 'group' | 'room'
  userId?: string
}

export interface LineMessage {
  type: string
  id: string
  text?: string
}

export interface LineTextMessageEvent extends LineEvent {
  type: 'message'
  source: LineSource & { userId: string }
  message: LineMessage & { type: 'text'; text: string }
}

export function isTextMessageEvent(event: LineEvent): event is LineTextMessageEvent {
  return (
    event.type === 'message' &&
    event.message?.type === 'text' &&
    typeof event.message.text === 'string' &&
    typeof event.source.userId === 'string'
  )
}

export interface AccessConfig {
  mode: 'pairing' | 'allowlist' | 'disabled'
  allowed_users: AllowedUser[]
}

export interface AllowedUser {
  id: string
  name: string
  paired_at: string
}

export interface PairingState {
  userId: string
  code: string
  createdAt: number
  attempts: number
}
```

- [ ] **Step 2: コミット**

```bash
git add src/types.ts
git commit -m "feat: add LINE webhook event type definitions"
```

---

### Task 3: HMAC-SHA256 署名検証

**Files:**
- Create: `src/signature.ts`
- Create: `tests/signature.test.ts`

- [ ] **Step 1: テスト作成**

```ts
// tests/signature.test.ts
import { describe, expect, test } from 'bun:test'
import { verifySignature } from '../src/signature'

describe('verifySignature', () => {
  const secret = '8c570fa6dd201bb328f1c1eac23a96d8'
  const body = '{"destination":"U8e742f61d673b39c7fff3cecb7536ef0","events":[]}'
  // openssl で算出した正しい署名
  const validSignature = 'GhRKmvmHys4Pi8DxkF4+EayaH0OqtJtaZxgTD9fMDLs='

  test('valid signature returns true', async () => {
    const result = await verifySignature(body, secret, validSignature)
    expect(result).toBe(true)
  })

  test('invalid signature returns false', async () => {
    const result = await verifySignature(body, secret, 'invalidsignature==')
    expect(result).toBe(false)
  })

  test('tampered body returns false', async () => {
    const tampered = body.replace('events', 'hacked')
    const result = await verifySignature(tampered, secret, validSignature)
    expect(result).toBe(false)
  })

  test('wrong secret returns false', async () => {
    const result = await verifySignature(body, 'wrong_secret', validSignature)
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 2: テスト実行 -> 失敗を確認**

```bash
bun test tests/signature.test.ts
```

Expected: FAIL -- `Cannot find module '../src/signature'`

- [ ] **Step 3: 実装**

```ts
// src/signature.ts
export async function verifySignature(
  body: string,
  secret: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  let sigBuf: Uint8Array
  try {
    sigBuf = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
  } catch {
    return false
  }

  return crypto.subtle.verify('HMAC', key, sigBuf, encoder.encode(body))
}
```

- [ ] **Step 4: テスト実行 -> 成功を確認**

```bash
bun test tests/signature.test.ts
```

Expected: 4 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/signature.ts tests/signature.test.ts
git commit -m "feat: add HMAC-SHA256 signature verification with timing-safe comparison"
```

---

### Task 4: LINE Push API クライアント

**Files:**
- Create: `src/line-api.ts`
- Create: `tests/line-api.test.ts`

- [ ] **Step 1: テスト作成**

```ts
// tests/line-api.test.ts
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { splitText, createLineClient } from '../src/line-api'

describe('splitText', () => {
  test('short text returns single chunk', () => {
    const result = splitText('hello', 5000)
    expect(result).toEqual(['hello'])
  })

  test('text at exact limit returns single chunk', () => {
    const text = 'a'.repeat(5000)
    const result = splitText(text, 5000)
    expect(result).toEqual([text])
  })

  test('text exceeding limit is split', () => {
    const text = 'a'.repeat(7500)
    const result = splitText(text, 5000)
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveLength(5000)
    expect(result[1]).toHaveLength(2500)
  })

  test('empty text returns single empty chunk', () => {
    const result = splitText('', 5000)
    expect(result).toEqual([''])
  })
})

describe('createLineClient', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('pushMessage sends correct request', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    )
    globalThis.fetch = fetchMock

    const client = createLineClient('test-token')
    await client.pushMessage('U1234567890abcdef', 'Hello')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.line.me/v2/bot/message/push')
    expect(options.method).toBe('POST')
    expect(options.headers['Authorization']).toBe('Bearer test-token')

    const body = JSON.parse(options.body)
    expect(body.to).toBe('U1234567890abcdef')
    expect(body.messages[0].type).toBe('text')
    expect(body.messages[0].text).toBe('Hello')
  })

  test('pushMessage splits long text into multiple calls', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    )
    globalThis.fetch = fetchMock

    const client = createLineClient('test-token')
    await client.pushMessage('U1234567890abcdef', 'a'.repeat(7500))

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('pushMessage logs error on API failure', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('{"message":"error"}', { status: 400 }))
    )
    globalThis.fetch = fetchMock

    const client = createLineClient('test-token')
    // Should not throw, just log to stderr
    await client.pushMessage('U1234567890abcdef', 'Hello')
  })
})
```

- [ ] **Step 2: テスト実行 -> 失敗を確認**

```bash
bun test tests/line-api.test.ts
```

Expected: FAIL -- `Cannot find module '../src/line-api'`

- [ ] **Step 3: 実装**

```ts
// src/line-api.ts
const PUSH_API_URL = 'https://api.line.me/v2/bot/message/push'
const MAX_TEXT_LENGTH = 5000

export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength))
  }
  return chunks
}

export function createLineClient(accessToken: string) {
  let messageCount = 0

  async function pushMessage(userId: string, text: string): Promise<void> {
    const chunks = splitText(text, MAX_TEXT_LENGTH)
    for (const chunk of chunks) {
      const res = await fetch(PUSH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: 'text', text: chunk }],
        }),
      })
      messageCount++
      if (!res.ok) {
        const body = await res.text()
        console.error(`[line] Push API error (${res.status}): ${body}`)
      }
      if (messageCount % 50 === 0) {
        console.error(`[line] ${messageCount} messages sent this session`)
      }
    }
  }

  return { pushMessage }
}

export type LineClient = ReturnType<typeof createLineClient>
```

- [ ] **Step 4: テスト実行 -> 成功を確認**

```bash
bun test tests/line-api.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/line-api.ts tests/line-api.test.ts
git commit -m "feat: add LINE Push API client with text splitting"
```

---

### Task 5: アクセス制御 & ペアリング

**Files:**
- Create: `src/access-control.ts`
- Create: `tests/access-control.test.ts`

- [ ] **Step 1: テスト作成**

```ts
// tests/access-control.test.ts
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { createAccessControl } from '../src/access-control'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'

describe('AccessControl', () => {
  let tempDir: string
  let accessPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'line-test-'))
    accessPath = join(tempDir, 'access.json')
  })

  test('initial mode is pairing', async () => {
    const ac = await createAccessControl(accessPath)
    expect(ac.getMode()).toBe('pairing')
  })

  test('isAllowed returns false for unknown user in pairing mode', async () => {
    const ac = await createAccessControl(accessPath)
    expect(ac.isAllowed('U_unknown')).toBe(false)
  })

  test('isAllowed returns true for paired user', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    expect(ac.isAllowed('U_test')).toBe(true)
  })

  test('addUser switches mode to allowlist', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    expect(ac.getMode()).toBe('allowlist')
  })

  test('startPairing generates 6-char code', async () => {
    const ac = await createAccessControl(accessPath)
    const result = ac.startPairing('U_new')
    expect(result.code).toHaveLength(6)
    expect(result.code).toMatch(/^[a-z0-9]{6}$/)
  })

  test('startPairing limits attempts to 2', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_new')
    ac.startPairing('U_new')
    const third = ac.startPairing('U_new')
    expect(third.error).toBe('too_many_attempts')
  })

  test('verifyPairing succeeds with correct code', async () => {
    const ac = await createAccessControl(accessPath)
    const { code } = ac.startPairing('U_new')
    const result = ac.verifyPairing(code)
    expect(result.success).toBe(true)
    expect(ac.isAllowed('U_new')).toBe(true)
  })

  test('verifyPairing fails with wrong code', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_new')
    const result = ac.verifyPairing('wrong1')
    expect(result.success).toBe(false)
  })

  test('pairing code expires after 1 hour', async () => {
    const ac = await createAccessControl(accessPath)
    const { code } = ac.startPairing('U_new')
    // Manually expire the pairing state
    ac._expirePairingForTest()
    const result = ac.verifyPairing(code)
    expect(result.success).toBe(false)
    expect(result.error).toBe('expired')
  })

  test('concurrent pairing rejects second user', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_first')
    const result = ac.startPairing('U_second')
    expect(result.error).toBe('pairing_in_progress')
  })

  test('disabled mode rejects all users', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    ac.setMode('disabled')
    expect(ac.isAllowed('U_test')).toBe(false)
  })

  test('persists to file', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    await ac.save()

    const ac2 = await createAccessControl(accessPath)
    expect(ac2.isAllowed('U_test')).toBe(true)
    expect(ac2.getMode()).toBe('allowlist')
  })

  test('removeUser removes from allowlist', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    ac.removeUser('U_test')
    expect(ac.isAllowed('U_test')).toBe(false)
  })

  test('listUsers returns allowed users', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_a', 'Alice')
    ac.addUser('U_b', 'Bob')
    const users = ac.listUsers()
    expect(users).toHaveLength(2)
    expect(users[0].id).toBe('U_a')
    expect(users[1].id).toBe('U_b')
  })
})
```

- [ ] **Step 2: テスト実行 -> 失敗を確認**

```bash
bun test tests/access-control.test.ts
```

Expected: FAIL -- `Cannot find module '../src/access-control'`

- [ ] **Step 3: 実装**

```ts
// src/access-control.ts
import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { AccessConfig, AllowedUser, PairingState } from './types'

const PAIRING_EXPIRY_MS = 60 * 60 * 1000 // 1 hour
const MAX_PAIRING_ATTEMPTS = 2

function generateCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let code = ''
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  for (const b of bytes) {
    code += chars[b % chars.length]
  }
  return code
}

export async function createAccessControl(filePath: string) {
  let config: AccessConfig = { mode: 'pairing', allowed_users: [] }
  let pairingState: PairingState | null = null

  // Load existing config
  try {
    const data = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (parsed.mode && Array.isArray(parsed.allowed_users)) {
      config = parsed
    }
  } catch {
    // File doesn't exist yet, use defaults
  }

  function getMode() {
    return config.mode
  }

  function setMode(mode: AccessConfig['mode']) {
    config.mode = mode
  }

  function isAllowed(userId: string): boolean {
    if (config.mode === 'disabled') return false
    return config.allowed_users.some((u) => u.id === userId)
  }

  function addUser(userId: string, name: string) {
    if (!config.allowed_users.some((u) => u.id === userId)) {
      config.allowed_users.push({
        id: userId,
        name,
        paired_at: new Date().toISOString(),
      })
    }
    config.mode = 'allowlist'
    pairingState = null
  }

  function removeUser(userId: string) {
    config.allowed_users = config.allowed_users.filter((u) => u.id !== userId)
  }

  function listUsers(): AllowedUser[] {
    return [...config.allowed_users]
  }

  function startPairing(
    userId: string,
  ): { code: string; error?: undefined } | { code?: undefined; error: string } {
    // Reject if another user is already pairing
    if (pairingState && pairingState.userId !== userId) {
      if (Date.now() - pairingState.createdAt < PAIRING_EXPIRY_MS) {
        return { error: 'pairing_in_progress' }
      }
      // Expired, allow new pairing
      pairingState = null
    }

    // Check attempt limit for same user
    if (pairingState && pairingState.userId === userId) {
      if (pairingState.attempts >= MAX_PAIRING_ATTEMPTS) {
        return { error: 'too_many_attempts' }
      }
      pairingState.attempts++
      pairingState.code = generateCode()
      pairingState.createdAt = Date.now()
      return { code: pairingState.code }
    }

    // New pairing
    const code = generateCode()
    pairingState = { userId, code, createdAt: Date.now(), attempts: 1 }
    return { code }
  }

  function verifyPairing(
    code: string,
  ): { success: true; userId: string } | { success: false; error: string } {
    if (!pairingState) {
      return { success: false, error: 'no_pending_pairing' }
    }
    if (Date.now() - pairingState.createdAt >= PAIRING_EXPIRY_MS) {
      pairingState = null
      return { success: false, error: 'expired' }
    }
    if (pairingState.code !== code) {
      return { success: false, error: 'invalid_code' }
    }
    const userId = pairingState.userId
    addUser(userId, userId) // name will be updated later if available
    return { success: true, userId }
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(config, null, 2))
  }

  // Test helper to expire pairing
  function _expirePairingForTest() {
    if (pairingState) {
      pairingState.createdAt = Date.now() - PAIRING_EXPIRY_MS - 1
    }
  }

  return {
    getMode,
    setMode,
    isAllowed,
    addUser,
    removeUser,
    listUsers,
    startPairing,
    verifyPairing,
    save,
    _expirePairingForTest,
  }
}

export type AccessControl = Awaited<ReturnType<typeof createAccessControl>>
```

- [ ] **Step 4: テスト実行 -> 成功を確認**

```bash
bun test tests/access-control.test.ts
```

Expected: 13 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/access-control.ts tests/access-control.test.ts
git commit -m "feat: add access control with pairing, allowlist, and persistence"
```

---

### Task 6: Permission Relay

**Files:**
- Create: `src/permission.ts`
- Create: `tests/permission.test.ts`

- [ ] **Step 1: テスト作成**

```ts
// tests/permission.test.ts
import { describe, expect, test } from 'bun:test'
import { parseVerdict, formatPermissionRequest } from '../src/permission'

describe('parseVerdict', () => {
  test('parses "yes abcde"', () => {
    const result = parseVerdict('yes abcde')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('parses "no fghij"', () => {
    const result = parseVerdict('no fghij')
    expect(result).toEqual({ behavior: 'deny', requestId: 'fghij' })
  })

  test('parses shorthand "y abcde"', () => {
    const result = parseVerdict('y abcde')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('parses shorthand "n abcde"', () => {
    const result = parseVerdict('n abcde')
    expect(result).toEqual({ behavior: 'deny', requestId: 'abcde' })
  })

  test('tolerates leading/trailing whitespace', () => {
    const result = parseVerdict('  yes abcde  ')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('case insensitive', () => {
    const result = parseVerdict('YES ABCDE')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('rejects request_id containing "l"', () => {
    const result = parseVerdict('yes abcle')
    expect(result).toBeNull()
  })

  test('rejects wrong length request_id', () => {
    const result = parseVerdict('yes abc')
    expect(result).toBeNull()
  })

  test('returns null for non-verdict text', () => {
    const result = parseVerdict('Hello, how are you?')
    expect(result).toBeNull()
  })

  test('returns null for empty string', () => {
    const result = parseVerdict('')
    expect(result).toBeNull()
  })
})

describe('formatPermissionRequest', () => {
  test('formats permission request message', () => {
    const msg = formatPermissionRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a shell command',
      input_preview: '{"command":"ls -la"}',
    })
    expect(msg).toContain('Bash')
    expect(msg).toContain('Run a shell command')
    expect(msg).toContain('ls -la')
    expect(msg).toContain('yes abcde')
    expect(msg).toContain('no abcde')
  })
})
```

- [ ] **Step 2: テスト実行 -> 失敗を確認**

```bash
bun test tests/permission.test.ts
```

Expected: FAIL -- `Cannot find module '../src/permission'`

- [ ] **Step 3: 実装**

```ts
// src/permission.ts
import { z } from 'zod'

const VERDICT_PATTERN = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export interface Verdict {
  behavior: 'allow' | 'deny'
  requestId: string
}

export interface PermissionRequestParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

export function parseVerdict(text: string): Verdict | null {
  const match = text.match(VERDICT_PATTERN)
  if (!match) return null

  const answer = match[1].toLowerCase()
  const requestId = match[2].toLowerCase()

  return {
    behavior: answer === 'y' || answer === 'yes' ? 'allow' : 'deny',
    requestId,
  }
}

export function formatPermissionRequest(params: PermissionRequestParams): string {
  return (
    `Claude が ${params.tool_name} を実行しようとしています:\n` +
    `${params.description}\n\n` +
    `${params.input_preview}\n\n` +
    `承認: yes ${params.request_id}\n` +
    `拒否: no ${params.request_id}`
  )
}
```

- [ ] **Step 4: テスト実行 -> 成功を確認**

```bash
bun test tests/permission.test.ts
```

Expected: 11 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/permission.ts tests/permission.test.ts
git commit -m "feat: add permission relay with verdict parsing and message formatting"
```

---

### Task 7: Webhook ハンドラ (Hono)

**Files:**
- Create: `src/webhook.ts`
- Create: `tests/webhook.test.ts`

- [ ] **Step 1: テスト作成**

```ts
// tests/webhook.test.ts
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { createWebhookApp } from '../src/webhook'

// Helper: compute valid signature for a body
async function computeSignature(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

const SECRET = 'test_secret_key'

describe('webhook', () => {
  test('returns 401 when x-line-signature is missing', async () => {
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onVerdict: mock(() => {}),
    })
    const res = await app.request('/webhook', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  test('returns 403 when signature is invalid', async () => {
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onVerdict: mock(() => {}),
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body: '{}',
      headers: { 'x-line-signature': 'invalidsig==' },
    })
    expect(res.status).toBe(403)
  })

  test('returns 200 for valid empty events (URL verification)', async () => {
    const body = '{"destination":"U123","events":[]}'
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onVerdict: mock(() => {}),
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
  })

  test('calls onTextMessage for text message events', async () => {
    const onTextMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_001',
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U_sender' },
        message: { type: 'text', id: 'msg_001', text: 'Hello' },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage,
      onVerdict: mock(() => {}),
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 10))
    expect(onTextMessage).toHaveBeenCalledTimes(1)
    expect(onTextMessage.mock.calls[0][0]).toBe('U_sender')
    expect(onTextMessage.mock.calls[0][1]).toBe('Hello')
  })

  test('calls onVerdict for verdict messages', async () => {
    const onVerdict = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_002',
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U_sender' },
        message: { type: 'text', id: 'msg_002', text: 'yes abcde' },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onVerdict,
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    expect(onVerdict).toHaveBeenCalledTimes(1)
    expect(onVerdict.mock.calls[0][0]).toBe('allow')
    expect(onVerdict.mock.calls[0][1]).toBe('abcde')
  })

  test('deduplicates events by webhookEventId', async () => {
    const onTextMessage = mock(() => {})
    const event = {
      type: 'message',
      webhookEventId: 'evt_dup',
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U_sender' },
      message: { type: 'text', id: 'msg_dup', text: 'Hello' },
    }
    const body = JSON.stringify({ destination: 'U123', events: [event] })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage,
      onVerdict: mock(() => {}),
    })

    // Send same event twice
    await app.request('/webhook', {
      method: 'POST', body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await app.request('/webhook', {
      method: 'POST', body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(onTextMessage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: テスト実行 -> 失敗を確認**

```bash
bun test tests/webhook.test.ts
```

Expected: FAIL -- `Cannot find module '../src/webhook'`

- [ ] **Step 3: 実装**

```ts
// src/webhook.ts
import { Hono } from 'hono'
import { verifySignature } from './signature'
import { parseVerdict } from './permission'
import { isTextMessageEvent } from './types'
import type { LineWebhookBody, Verdict } from './types'

const MAX_SEEN_EVENTS = 1000

interface WebhookAppOptions {
  channelSecret: string
  onTextMessage: (userId: string, text: string, eventId: string) => void
  onVerdict: (behavior: Verdict['behavior'], requestId: string) => void
}

export function createWebhookApp(options: WebhookAppOptions) {
  const app = new Hono()
  const seenEventIds = new Map<string, number>()

  function dedup(eventId: string): boolean {
    if (seenEventIds.has(eventId)) return true
    seenEventIds.set(eventId, Date.now())
    // Evict oldest entries when exceeding limit
    if (seenEventIds.size > MAX_SEEN_EVENTS) {
      const firstKey = seenEventIds.keys().next().value!
      seenEventIds.delete(firstKey)
    }
    return false
  }

  app.post('/webhook', async (c) => {
    // Step 1: Check signature header
    const signature = c.req.header('x-line-signature')
    if (!signature) {
      return c.text('Missing x-line-signature', 401)
    }

    // Step 2: Get raw body before parsing
    const rawBody = await c.req.text()

    // Step 3: Verify signature
    const valid = await verifySignature(rawBody, options.channelSecret, signature)
    if (!valid) {
      return c.text('Invalid signature', 403)
    }

    // Step 4: Return 200 immediately, process async
    const body: LineWebhookBody = JSON.parse(rawBody)

    // Process events asynchronously
    queueMicrotask(() => {
      // Step 5: Empty events = URL verification
      if (body.events.length === 0) return

      for (const event of body.events) {
        // Step 6: Filter text message events
        if (!isTextMessageEvent(event)) continue

        // Step 7: Deduplicate
        if (dedup(event.webhookEventId)) continue

        const userId = event.source.userId
        const text = event.message.text

        // Step 9: Check verdict pattern
        const verdict = parseVerdict(text)
        if (verdict) {
          options.onVerdict(verdict.behavior, verdict.requestId)
          continue
        }

        // Step 10: Regular message
        options.onTextMessage(userId, text, event.webhookEventId)
      }
    })

    return c.text('OK', 200)
  })

  return app
}
```

- [ ] **Step 4: テスト実行 -> 成功を確認**

```bash
bun test tests/webhook.test.ts
```

Expected: 6 tests passed

- [ ] **Step 5: コミット**

```bash
git add src/webhook.ts tests/webhook.test.ts
git commit -m "feat: add Hono webhook handler with signature verification and dedup"
```

---

### Task 8: MCP Server エントリポイント

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: src/server.ts 作成**

```ts
// src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createWebhookApp } from './webhook'
import { createLineClient } from './line-api'
import { createAccessControl } from './access-control'
import {
  PermissionRequestSchema,
  formatPermissionRequest,
} from './permission'
import { join } from 'path'
import { homedir } from 'os'

// --- Config ---
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN
const PORT = parseInt(process.env.LINE_WEBHOOK_PORT || '8788', 10)

if (!CHANNEL_SECRET || !ACCESS_TOKEN) {
  console.error('[line] Missing LINE_CHANNEL_SECRET or LINE_CHANNEL_ACCESS_TOKEN')
  console.error('[line] Run /line:configure to set up credentials')
  process.exit(1)
}

// --- State ---
const channelDir = join(homedir(), '.claude', 'channels', 'line')
const accessPath = join(channelDir, 'access.json')
const lineClient = createLineClient(ACCESS_TOKEN)
const accessControl = await createAccessControl(accessPath)

// Track last active user for permission relay
let lastActiveUserId: string | null = null

// --- MCP Server ---
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

// --- Tool Handlers ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'line_reply',
      description: 'Send a reply to a LINE user',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: { type: 'string', description: 'LINE user ID (starts with U)' },
          text: { type: 'string', description: 'Message text' },
        },
        required: ['user_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'line_reply') {
    const { user_id, text } = request.params.arguments as { user_id: string; text: string }
    await lineClient.pushMessage(user_id, text)
    return { content: [{ type: 'text' as const, text: 'Message sent.' }] }
  }
  throw new Error(`Unknown tool: ${request.params.name}`)
})

// --- Permission Relay ---
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const targetUserId = lastActiveUserId
  if (!targetUserId) {
    console.error('[line] Permission request received but no active user')
    return
  }
  const msg = formatPermissionRequest(params)
  await lineClient.pushMessage(targetUserId, msg)
})

// --- Webhook App ---
const app = createWebhookApp({
  channelSecret: CHANNEL_SECRET,
  onTextMessage: async (userId, text, eventId) => {
    // Sender gating
    if (!accessControl.isAllowed(userId)) {
      if (accessControl.getMode() === 'pairing') {
        const result = accessControl.startPairing(userId)
        if (result.error === 'pairing_in_progress') {
          await lineClient.pushMessage(userId, 'ペアリング中です。しばらくお待ちください。')
          return
        }
        if (result.error === 'too_many_attempts') {
          await lineClient.pushMessage(userId, 'しばらく待ってから再試行してください。')
          return
        }
        if (result.code) {
          await lineClient.pushMessage(
            userId,
            `ペアリングコード: ${result.code}\nClaude Code ターミナルで /line:access pair ${result.code} を実行してください。`,
          )
          // Notify Claude Code terminal
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: `LINE ペアリングリクエスト: ユーザー ${userId} がペアリングコード ${result.code} を受け取りました。/line:access pair ${result.code} で承認してください。`,
              meta: { user_id: userId, pairing_code: result.code },
            },
          })
        }
        return
      }
      // Disabled or allowlist mode - ignore
      return
    }

    lastActiveUserId = userId
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { user_id: userId },
      },
    })
  },
  onVerdict: async (behavior, requestId) => {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior },
    })
  },
})

// --- Start HTTP Server ---
const httpServer = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.error(`[line] Webhook server listening on http://127.0.0.1:${PORT}/webhook`)
console.error(`[line] Access mode: ${accessControl.getMode()}`)

// --- Graceful Shutdown ---
process.stdin.on('end', () => {
  console.error('[line] stdin closed, shutting down')
  httpServer.stop()
  process.exit(0)
})

// --- Connect MCP ---
const transport = new StdioServerTransport()
await mcp.connect(transport)
```

- [ ] **Step 2: 型チェック**

```bash
bunx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: コミット**

```bash
git add src/server.ts
git commit -m "feat: add MCP server entry point with webhook, tools, and permission relay"
```

---

### Task 9: Skills (スラッシュコマンド)

**Files:**
- Create: `skills/configure/configure.md`
- Create: `skills/access/access.md`

- [ ] **Step 1: skills/configure/configure.md 作成**

```markdown
---
name: configure
description: Configure LINE channel credentials (channel secret and access token)
---

# LINE Channel Configuration

Set up your LINE Messaging API credentials.

## Steps

1. Go to LINE Developers Console (https://developers.line.biz/)
2. Select your Messaging API channel
3. Copy the Channel Secret (Basic settings tab)
4. Copy the Channel Access Token (Messaging API tab -> Issue)

Now save the credentials:

\`\`\`bash
mkdir -p ~/.claude/channels/line
cat > ~/.claude/channels/line/.env << 'DOTENV'
LINE_CHANNEL_SECRET=<paste your channel secret>
LINE_CHANNEL_ACCESS_TOKEN=<paste your channel access token>
DOTENV
\`\`\`

## Webhook URL Setup

1. Install cloudflared: `brew install cloudflared`
2. Start tunnel: `cloudflared tunnel --url http://localhost:8788`
3. Copy the generated URL (e.g., `https://xxxxx.trycloudflare.com`)
4. In LINE Developers Console -> Messaging API tab:
   - Set Webhook URL to `https://xxxxx.trycloudflare.com/webhook`
   - Enable "Use webhook"
   - Disable "Auto-reply messages"
5. Click "Verify" to test the connection
```

- [ ] **Step 2: skills/access/access.md 作成**

```markdown
---
name: access
description: Manage LINE channel access control - pairing, allowlist, and policy
args: <subcommand> [arguments]
---

# LINE Access Control

Manage who can interact with Claude Code through LINE.

## Commands

### Pair with a LINE user

When a LINE user sends their first message, they receive a pairing code.
Enter it here to authorize them:

\`\`\`bash
# Read the pairing code from LINE and enter it:
# The access-control module will verify and add the user
\`\`\`

To pair, the agent should call the access control's `verifyPairing` method with the code provided.

### Check access policy

Current access mode and allowed users can be viewed via the access.json file:

\`\`\`bash
cat ~/.claude/channels/line/access.json
\`\`\`

### Change access mode

Edit access.json to change the mode field:
- `"pairing"` - Accept new pairing requests
- `"allowlist"` - Only allow paired users (default after first pairing)
- `"disabled"` - Block all LINE messages

### Remove a user

Edit access.json and remove the user entry from the `allowed_users` array.
```

- [ ] **Step 3: コミット**

```bash
git add skills/configure/configure.md skills/access/access.md
git commit -m "feat: add /line:configure and /line:access skills"
```

---

### Task 10: 全テスト実行 & 手動検証手順

**Files:**
- Modify: (none, verification only)

- [ ] **Step 1: 全テスト実行**

```bash
bun test
```

Expected: All tests pass (signature: 4, line-api: 6, access-control: 13, permission: 11, webhook: 6 = 40 tests)

- [ ] **Step 2: 型チェック**

```bash
bunx tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: 手動起動テスト(MCP なしで HTTP サーバーのみ)**

環境変数をダミーで設定し、サーバーが起動することを確認:

```bash
LINE_CHANNEL_SECRET=test LINE_CHANNEL_ACCESS_TOKEN=test bun src/server.ts
```

Expected: `[line] Webhook server listening on http://127.0.0.1:8788/webhook` が stderr に出力される。stdin が MCP transport として接続されるため、MCP 初期化エラーが出る可能性があるが、HTTP サーバーは起動する。Ctrl+C で終了。

- [ ] **Step 4: コミット(最終)**

```bash
git add -A
git commit -m "chore: verify all tests pass and server starts"
```

---

## 手動 E2E テスト手順(LINE Developers Console 設定後)

以下は LINE credentials 設定後に行う手動テスト。Task 10 のスコープ外だが、参考として記載。

1. `~/.claude/channels/line/.env` に credentials を設定
2. `cloudflared tunnel --url http://localhost:8788` でトンネル起動
3. LINE Developers Console で Webhook URL を設定 & Verify
4. tmux で `claude --dangerously-load-development-channels server:line` 起動
5. LINE アプリで Bot を友だち追加し、メッセージ送信
6. ペアリングコードが返信されることを確認
7. Claude Code ターミナルで `/line:access pair <code>` を実行
8. LINE から「このディレクトリのファイルを一覧して」と送信
9. Permission prompt が LINE に届くことを確認
10. `yes xxxxx` で承認し、結果が返信されることを確認
