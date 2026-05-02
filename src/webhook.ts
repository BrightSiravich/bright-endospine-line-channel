import { Hono } from 'hono'
import { verifySignature } from './signature'
import { parseVerdict } from './permission'
import { isTextMessageEvent, isImageMessageEvent } from './types'
import type { LineWebhookBody } from './types'
import type { Verdict } from './permission'

const MAX_SEEN_EVENTS = 1000

interface WebhookAppOptions {
  channelSecret: string
  onTextMessage: (userId: string, text: string, eventId: string, replyTo: string) => void
  onVerdict: (behavior: Verdict['behavior'], requestId: string) => void
  /**
   * Called when an image message arrives. The webhook handler ONLY guarantees
   * dedup + signature + structural validity; downloading the bytes, persisting
   * them, and forwarding the MCP notification are the caller's responsibility.
   *
   * `messageId` is the LINE message id — call `lineClient.getMessageContent`
   * with it to retrieve the bytes. `eventId` is the webhookEventId, suitable
   * (after sanitization in image-store) as a filename component.
   */
  onImageMessage?: (
    userId: string,
    messageId: string,
    eventId: string,
    replyTo: string,
  ) => void
  getLastRequestId?: () => string | null
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

    // Step 4: Parse body — return 400 on malformed JSON.
    // (Signature verified above, so a malformed body here is unusual but
    // possible; better to return a clean 400 than let Hono surface a 500.)
    let body: LineWebhookBody
    try {
      body = JSON.parse(rawBody)
    } catch {
      return c.text('Invalid JSON', 400)
    }

    // Process events asynchronously
    queueMicrotask(() => {
      // Step 5: Empty events = URL verification
      if (body.events.length === 0) return

      for (const event of body.events) {
        // Step 6: Dispatch by message type. Text and image are handled;
        // every other event type (sticker, video, audio, location, file,
        // follow, unfollow, postback, …) is still silently dropped.
        if (isTextMessageEvent(event)) {
          // Step 7: Deduplicate
          if (dedup(event.webhookEventId)) continue

          const userId = event.source.userId
          const text = event.message.text
          const replyTo = event.source.groupId ?? event.source.roomId ?? userId

          // Step 8: Check verdict pattern (bare yes/no uses last pending request_id)
          const verdict = parseVerdict(text, options.getLastRequestId?.() ?? undefined)
          if (verdict) {
            options.onVerdict(verdict.behavior, verdict.requestId)
            continue
          }

          // Step 9: Regular text message
          options.onTextMessage(userId, text, event.webhookEventId, replyTo)
          continue
        }

        if (isImageMessageEvent(event) && options.onImageMessage) {
          // Step 7: Deduplicate (same dedup pool as text — webhookEventIds
          // are unique across all event types per LINE spec).
          if (dedup(event.webhookEventId)) continue

          const userId = event.source.userId
          const messageId = event.message.id
          const replyTo = event.source.groupId ?? event.source.roomId ?? userId

          // Step 9: Image message — caller fetches bytes and persists.
          options.onImageMessage(userId, messageId, event.webhookEventId, replyTo)
          continue
        }

        // Anything else: drop (parity with prior behavior for non-text events).
      }
    })

    return c.text('OK', 200)
  })

  return app
}
