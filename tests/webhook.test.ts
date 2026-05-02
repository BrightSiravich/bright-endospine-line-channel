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
    // replyTo falls back to userId for 1:1 chat
    expect(onTextMessage.mock.calls[0][3]).toBe('U_sender')
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

  test('passes groupId as replyTo for group messages', async () => {
    const onTextMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_grp_001',
        timestamp: Date.now(),
        source: { type: 'group', groupId: 'C_group_abc', userId: 'U_sender' },
        message: { type: 'text', id: 'msg_grp_001', text: 'Hello from group' },
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
    await new Promise((r) => setTimeout(r, 10))
    expect(onTextMessage).toHaveBeenCalledTimes(1)
    expect(onTextMessage.mock.calls[0][0]).toBe('U_sender')
    expect(onTextMessage.mock.calls[0][1]).toBe('Hello from group')
    expect(onTextMessage.mock.calls[0][3]).toBe('C_group_abc')
  })

  test('passes roomId as replyTo for room messages', async () => {
    const onTextMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_room_001',
        timestamp: Date.now(),
        source: { type: 'room', roomId: 'R_room_xyz', userId: 'U_sender' },
        message: { type: 'text', id: 'msg_room_001', text: 'Hello from room' },
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
    await new Promise((r) => setTimeout(r, 10))
    expect(onTextMessage).toHaveBeenCalledTimes(1)
    expect(onTextMessage.mock.calls[0][0]).toBe('U_sender')
    expect(onTextMessage.mock.calls[0][1]).toBe('Hello from room')
    expect(onTextMessage.mock.calls[0][3]).toBe('R_room_xyz')
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

  // ---------------- Image dispatch ----------------

  test('calls onImageMessage for image message events with correct args', async () => {
    const onImageMessage = mock(() => {})
    const onTextMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_img_001',
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U_sender' },
        message: {
          type: 'image',
          id: '460000000000000001',
          contentProvider: { type: 'line' },
        },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage,
      onImageMessage,
      onVerdict: mock(() => {}),
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 10))
    // Image branch fired, text branch did NOT.
    expect(onImageMessage).toHaveBeenCalledTimes(1)
    expect(onTextMessage).toHaveBeenCalledTimes(0)
    const [userId, messageId, eventId, replyTo] = onImageMessage.mock.calls[0]
    expect(userId).toBe('U_sender')
    expect(messageId).toBe('460000000000000001')
    expect(eventId).toBe('evt_img_001')
    // 1:1 chat → replyTo falls back to userId.
    expect(replyTo).toBe('U_sender')
  })

  test('passes groupId as replyTo for image messages from groups', async () => {
    const onImageMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_img_grp',
        timestamp: Date.now(),
        source: { type: 'group', groupId: 'C_group_OR', userId: 'U_sender' },
        message: { type: 'image', id: 'msg_img_grp', contentProvider: { type: 'line' } },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onImageMessage,
      onVerdict: mock(() => {}),
    })
    await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(onImageMessage).toHaveBeenCalledTimes(1)
    expect(onImageMessage.mock.calls[0][3]).toBe('C_group_OR')
  })

  test('image events are deduplicated alongside text events', async () => {
    const onImageMessage = mock(() => {})
    const event = {
      type: 'message',
      webhookEventId: 'evt_img_dup',
      timestamp: Date.now(),
      source: { type: 'user', userId: 'U_sender' },
      message: { type: 'image', id: 'msg_dup_img', contentProvider: { type: 'line' } },
    }
    const body = JSON.stringify({ destination: 'U123', events: [event] })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onImageMessage,
      onVerdict: mock(() => {}),
    })
    await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(onImageMessage).toHaveBeenCalledTimes(1)
  })

  test('image events drop silently if onImageMessage is not provided', async () => {
    // Backward-compat: a caller that only registers onTextMessage should NOT
    // crash when an image event arrives.
    const onTextMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_img_noop',
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U_sender' },
        message: { type: 'image', id: 'msg', contentProvider: { type: 'line' } },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage,
      onVerdict: mock(() => {}),
      // onImageMessage intentionally omitted.
    })
    const res = await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(res.status).toBe(200)
    expect(onTextMessage).toHaveBeenCalledTimes(0)
  })

  // ---------------- Non-text-non-image events still drop ----------------

  test('lift is image-only — sticker/video/audio/location/file still drop', async () => {
    // Critical: this is the regression guard that proves we did NOT blanket
    // un-drop everything at line 65. Each non-image, non-text event must
    // pass through without calling any callback.
    const onTextMessage = mock(() => {})
    const onImageMessage = mock(() => {})
    const onVerdict = mock(() => {})

    for (const messageType of ['sticker', 'video', 'audio', 'location', 'file']) {
      const body = JSON.stringify({
        destination: 'U123',
        events: [{
          type: 'message',
          webhookEventId: `evt_${messageType}_001`,
          timestamp: Date.now(),
          source: { type: 'user', userId: 'U_sender' },
          message: { type: messageType, id: `msg_${messageType}` },
        }],
      })
      const sig = await computeSignature(body, SECRET)
      const app = createWebhookApp({
        channelSecret: SECRET,
        onTextMessage,
        onImageMessage,
        onVerdict,
      })
      const res = await app.request('/webhook', {
        method: 'POST',
        body,
        headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
      })
      expect(res.status).toBe(200)
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(onTextMessage).toHaveBeenCalledTimes(0)
    expect(onImageMessage).toHaveBeenCalledTimes(0)
    expect(onVerdict).toHaveBeenCalledTimes(0)
  })

  test('non-message event types (follow, unfollow, postback) still drop', async () => {
    const onTextMessage = mock(() => {})
    const onImageMessage = mock(() => {})

    for (const eventType of ['follow', 'unfollow', 'postback']) {
      const body = JSON.stringify({
        destination: 'U123',
        events: [{
          type: eventType,
          webhookEventId: `evt_${eventType}_001`,
          timestamp: Date.now(),
          source: { type: 'user', userId: 'U_sender' },
        }],
      })
      const sig = await computeSignature(body, SECRET)
      const app = createWebhookApp({
        channelSecret: SECRET,
        onTextMessage,
        onImageMessage,
        onVerdict: mock(() => {}),
      })
      const res = await app.request('/webhook', {
        method: 'POST',
        body,
        headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
      })
      expect(res.status).toBe(200)
      await new Promise((r) => setTimeout(r, 5))
    }

    expect(onTextMessage).toHaveBeenCalledTimes(0)
    expect(onImageMessage).toHaveBeenCalledTimes(0)
  })

  test('image with external contentProvider is rejected (does not fire onImageMessage)', async () => {
    // External-provider images would force us to fetch from an
    // attacker-controlled URL — type guard must reject these even though
    // they're nominally "image" type.
    const onImageMessage = mock(() => {})
    const body = JSON.stringify({
      destination: 'U123',
      events: [{
        type: 'message',
        webhookEventId: 'evt_img_external',
        timestamp: Date.now(),
        source: { type: 'user', userId: 'U_sender' },
        message: {
          type: 'image',
          id: 'extmsg',
          contentProvider: {
            type: 'external',
            originalContentUrl: 'https://attacker.example/x.png',
          },
        },
      }],
    })
    const sig = await computeSignature(body, SECRET)
    const app = createWebhookApp({
      channelSecret: SECRET,
      onTextMessage: mock(() => {}),
      onImageMessage,
      onVerdict: mock(() => {}),
    })
    await app.request('/webhook', {
      method: 'POST',
      body,
      headers: { 'x-line-signature': sig, 'content-type': 'application/json' },
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(onImageMessage).toHaveBeenCalledTimes(0)
  })
})
