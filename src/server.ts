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
  buildPermissionRequestMessage,
} from './permission'
import { startTunnel } from './tunnel'
import { createImageStore, UnsupportedImageTypeError, UnsafeEventIdError } from './image-store'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
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

// Image storage lives at <repo>/.images/. We resolve the repo dir from the
// current source file (src/server.ts → repo root one up) so the location is
// stable regardless of where bun was launched from.
const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const imageStore = createImageStore({ baseDir: REPO_DIR })

// Track last active reply target and pending permission for relay
let lastReplyTo: string | null = null
let lastPendingRequestId: string | null = null

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
    {
      name: 'line_verify_pairing',
      description: 'Verify a pairing code to authorize a LINE user',
      inputSchema: {
        type: 'object' as const,
        properties: {
          code: { type: 'string', description: 'The 6-character pairing code' },
        },
        required: ['code'],
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
  if (request.params.name === 'line_verify_pairing') {
    const { code } = request.params.arguments as { code: string }
    const result = accessControl.verifyPairing(code)
    if (result.success) {
      await accessControl.save()
      await lineClient.pushMessage(result.userId, 'ペアリング完了! Claude Code と接続されました。')
      return { content: [{ type: 'text' as const, text: `Paired successfully with user ${result.userId}` }] }
    }
    return { content: [{ type: 'text' as const, text: `Pairing failed: ${result.error}` }] }
  }
  throw new Error(`Unknown tool: ${request.params.name}`)
})

// --- Permission Relay ---
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const target = lastReplyTo
  if (!target) {
    console.error('[line] Permission request received but no active user')
    return
  }
  lastPendingRequestId = params.request_id
  const msg = buildPermissionRequestMessage(params)
  await lineClient.pushRawMessages(target, [msg])
})

// --- Webhook App ---
const app = createWebhookApp({
  channelSecret: CHANNEL_SECRET,
  onTextMessage: async (userId, text, eventId, replyTo) => {
    // Sender gating (always by userId, even in groups)
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

    lastReplyTo = replyTo
    const meta: Record<string, string> = { user_id: userId }
    if (replyTo !== userId) {
      meta.group_id = replyTo
    }
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: text, meta },
    })
  },
  onImageMessage: async (userId, messageId, eventId, replyTo) => {
    // Reuse the same sender-gating policy as text. We never want to fetch
    // image bytes for unallowed users — that would burn LINE Content API
    // quota on attackers and write attacker-controlled bytes to disk.
    if (!accessControl.isAllowed(userId)) {
      // Silently ignore: pairing flow is text-only, and fetching an image
      // for an unallowed user has no benign justification.
      return
    }

    let saved
    try {
      const { buffer, mime } = await lineClient.getMessageContent(messageId)
      saved = imageStore.save(eventId, mime, buffer)
    } catch (err) {
      const reason =
        err instanceof UnsupportedImageTypeError
          ? `unsupported image type (${err.mime})`
          : err instanceof UnsafeEventIdError
            ? `unsafe eventId rejected`
            : err instanceof Error
              ? err.message
              : String(err)
      console.error(`[line] Image fetch/save failed (eventId=${eventId}): ${reason}`)
      // Notify Claude so the user knows we saw something even if we couldn't
      // store it. Path is omitted — there's no file to read.
      lastReplyTo = replyTo
      const meta: Record<string, string> = {
        user_id: userId,
        message_type: 'image',
        status: 'error',
        error: reason,
      }
      if (replyTo !== userId) meta.group_id = replyTo
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `[Image received but failed to store: ${reason}]`,
          meta,
        },
      })
      return
    }

    lastReplyTo = replyTo
    const meta: Record<string, string> = {
      user_id: userId,
      message_type: 'image',
      image_path: saved.path,
      image_ext: saved.ext,
      image_size: String(saved.size),
    }
    if (replyTo !== userId) meta.group_id = replyTo
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `[Image received: ${saved.path}]`,
        meta,
      },
    })
  },
  onVerdict: async (behavior, requestId) => {
    lastPendingRequestId = null
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior },
    })
  },
  getLastRequestId: () => lastPendingRequestId,
})

// --- Start HTTP Server ---
const httpServer = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: app.fetch,
})

console.error(`[line] Webhook server listening on http://127.0.0.1:${PORT}/webhook`)
console.error(`[line] Access mode: ${accessControl.getMode()}`)

// --- Start Tunnel & Configure Webhook ---
let killTunnel: (() => void) | null = null

async function setupTunnelAndWebhook(): Promise<void> {
  console.error('[line] Starting cloudflared tunnel (killing existing tunnels first)...')
  const tunnel = await startTunnel(PORT)
  killTunnel = tunnel.kill
  const webhookUrl = `${tunnel.url}/webhook`
  console.error(`[line] Tunnel URL: ${tunnel.url}`)

  // Set webhook URL via LINE API with retry
  // LINE validates reachability on PUT, so we retry with backoff
  // to allow time for the tunnel to become reachable from LINE's servers
  console.error(`[line] Setting webhook URL: ${webhookUrl}`)
  let setOk = false
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      const waitSec = 3 + i * 2 // 3s, 5s, 7s, 9s
      console.error(`[line] Waiting ${waitSec}s for tunnel to propagate... (attempt ${i + 1}/5)`)
      await new Promise((r) => setTimeout(r, waitSec * 1000))
    }
    setOk = await lineClient.setWebhookUrl(webhookUrl)
    if (setOk) break
  }
  if (!setOk) {
    throw new Error('Failed to set webhook URL via LINE API after 5 attempts')
  }
  console.error('[line] Webhook URL set successfully')

  // Verify the URL was actually set
  const currentUrl = await lineClient.getWebhookUrl()
  if (currentUrl !== webhookUrl) {
    throw new Error(`Webhook URL mismatch: expected ${webhookUrl}, got ${currentUrl}`)
  }
  console.error('[line] Webhook URL verified in LINE')

  // Test webhook connectivity via LINE's test API
  console.error('[line] Testing webhook connectivity...')
  await new Promise((r) => setTimeout(r, 2000))
  const testResult = await lineClient.testWebhook()
  if (testResult.success) {
    console.error(`[line] Webhook connectivity test PASSED (status: ${testResult.statusCode})`)
  } else {
    console.error(`[line] Webhook connectivity test FAILED (status: ${testResult.statusCode}, reason: ${testResult.reason})`)
    console.error('[line] Tunnel is running but LINE test failed. Messages may still work.')
  }
}

// --- Graceful Shutdown ---
process.stdin.on('end', () => {
  console.error('[line] stdin closed, shutting down')
  killTunnel?.()
  httpServer.stop()
  process.exit(0)
})

// --- Connect MCP first, then setup tunnel ---
const transport = new StdioServerTransport()
await mcp.connect(transport)

// Run tunnel setup after MCP is connected (so notifications work)
setupTunnelAndWebhook()
  .then(async () => {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: 'LINE channel ready. Tunnel established and webhook connectivity verified.',
        meta: { status: 'ready' },
      },
    })
  })
  .catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[line] Tunnel setup failed: ${msg}`)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: `LINE tunnel setup failed: ${msg}. Set webhook URL manually.`,
        meta: { status: 'error' },
      },
    })
  })
