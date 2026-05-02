import { describe, expect, test } from 'bun:test'
import { isTextMessageEvent, isImageMessageEvent } from '../src/types'
import type { LineEvent } from '../src/types'

function baseEvent(overrides: Partial<LineEvent> = {}): LineEvent {
  return {
    type: 'message',
    webhookEventId: 'evt_test_001',
    timestamp: Date.now(),
    source: { type: 'user', userId: 'U_sender' },
    ...overrides,
  }
}

describe('isImageMessageEvent', () => {
  test('true positive: well-formed LINE-hosted image event', () => {
    const event = baseEvent({
      message: {
        type: 'image',
        id: '12345678',
        contentProvider: { type: 'line' },
      },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(true)
  })

  test('true positive: image event without contentProvider (forward-compat)', () => {
    const event = baseEvent({
      message: { type: 'image', id: '12345678' },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(true)
  })

  test('true positive: image event in a group also passes (userId still required)', () => {
    const event = baseEvent({
      source: { type: 'group', groupId: 'C_grp', userId: 'U_sender' },
      message: { type: 'image', id: '12345678', contentProvider: { type: 'line' } },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(true)
  })

  test('false: text message events', () => {
    const event = baseEvent({
      message: { type: 'text', id: 'm1', text: 'hello' },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: sticker, video, audio, location, file are not images', () => {
    for (const type of ['sticker', 'video', 'audio', 'location', 'file']) {
      const event = baseEvent({ message: { type, id: 'm1' } } as Partial<LineEvent>)
      expect(isImageMessageEvent(event)).toBe(false)
    }
  })

  test('false: external contentProvider is rejected (SSRF surface avoidance)', () => {
    const event = baseEvent({
      message: {
        type: 'image',
        id: '12345678',
        contentProvider: {
          type: 'external',
          originalContentUrl: 'https://attacker.example/payload.png',
        },
      },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: malformed — missing message entirely', () => {
    const event = baseEvent({})
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: malformed — missing message id', () => {
    const event = baseEvent({
      message: { type: 'image' } as Partial<LineEvent>['message'],
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: malformed — empty message id', () => {
    const event = baseEvent({
      message: { type: 'image', id: '' },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: malformed — non-message event type', () => {
    const event = baseEvent({
      type: 'follow',
      message: { type: 'image', id: '1' },
    } as Partial<LineEvent>)
    expect(isImageMessageEvent(event)).toBe(false)
  })

  test('false: malformed — missing source.userId', () => {
    const event: LineEvent = {
      type: 'message',
      webhookEventId: 'evt_001',
      timestamp: Date.now(),
      source: { type: 'group', groupId: 'C_grp' },
      message: { type: 'image', id: '12345678' },
    }
    expect(isImageMessageEvent(event)).toBe(false)
  })
})

describe('isTextMessageEvent — sanity (image events should not match text guard)', () => {
  test('image event does not match text guard', () => {
    const event = baseEvent({
      message: { type: 'image', id: '12345678' },
    } as Partial<LineEvent>)
    expect(isTextMessageEvent(event)).toBe(false)
  })
})
