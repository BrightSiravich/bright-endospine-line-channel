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
  groupId?: string
  roomId?: string
}

export interface LineMessage {
  type: string
  id: string
  text?: string
  // Present on image/video/audio events. We carry it on the base type so the
  // type guard for image messages can inspect it without a narrowing dance.
  contentProvider?: {
    type: 'line' | 'external'
    originalContentUrl?: string
    previewImageUrl?: string
  }
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

// LINE image message: per the Messaging API webhook spec, image events arrive
// without inline bytes — the receiver must call the Content API with the
// message id to fetch the actual image. See:
//   https://developers.line.biz/en/reference/messaging-api/#wh-image
//
// `contentProvider` (inherited from LineMessage) tells us whether LINE hosts
// the bytes (must fetch via Content API) or the user pre-uploaded to an
// external URL. We only handle 'line' — externals are dropped at the type
// guard to avoid ambient SSRF surface.
export interface LineImageMessage extends LineMessage {
  type: 'image'
}

export interface LineImageMessageEvent extends LineEvent {
  type: 'message'
  source: LineSource & { userId: string }
  message: LineImageMessage
}

export function isImageMessageEvent(event: LineEvent): event is LineImageMessageEvent {
  if (event.type !== 'message') return false
  if (!event.message || event.message.type !== 'image') return false
  if (typeof event.message.id !== 'string' || event.message.id.length === 0) return false
  if (typeof event.source.userId !== 'string') return false
  // If contentProvider is supplied (it usually is), require it to be 'line'.
  // Absence is tolerated for forward-compat with the spec — we treat it as
  // 'line' (LINE-hosted) by default, which matches every observed payload.
  const cp = event.message.contentProvider
  if (cp && cp.type !== 'line') return false
  return true
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
