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
