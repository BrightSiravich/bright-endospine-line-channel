import { z } from 'zod'

// Claude Code Channels spec: request_id is 5 lowercase letters (a-z excluding 'l')
// 'l' excluded to avoid confusion with '1'/'I' on mobile keyboards
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
