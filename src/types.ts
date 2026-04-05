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
