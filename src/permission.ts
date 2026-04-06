import { z } from 'zod'

// Claude Code Channels spec: request_id is 5 lowercase letters (a-z excluding 'l')
// 'l' excluded to avoid confusion with '1'/'I' on mobile keyboards
const VERDICT_WITH_ID_PATTERN = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const BARE_VERDICT_PATTERN = /^\s*(y|yes|n|no)\s*$/i

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

export function parseVerdict(text: string, fallbackRequestId?: string): Verdict | null {
  // Try with explicit request_id first
  const matchWithId = text.match(VERDICT_WITH_ID_PATTERN)
  if (matchWithId) {
    return {
      behavior: matchWithId[1].toLowerCase() === 'y' || matchWithId[1].toLowerCase() === 'yes' ? 'allow' : 'deny',
      requestId: matchWithId[2].toLowerCase(),
    }
  }

  // Try bare yes/no with fallback request_id
  const bareMatch = text.match(BARE_VERDICT_PATTERN)
  if (bareMatch && fallbackRequestId) {
    return {
      behavior: bareMatch[1].toLowerCase() === 'y' || bareMatch[1].toLowerCase() === 'yes' ? 'allow' : 'deny',
      requestId: fallbackRequestId,
    }
  }

  return null
}

export function formatPermissionRequest(params: PermissionRequestParams): string {
  return (
    `Claude が ${params.tool_name} を実行しようとしています:\n` +
    `${params.description}\n\n` +
    `${params.input_preview}\n\n` +
    `承認: yes\n` +
    `拒否: no`
  )
}
