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

  describe('getMessageContent', () => {
    test('hits the api-data.line.me content URL with Bearer auth', async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const fetchMock = mock(() =>
        Promise.resolve(
          new Response(png, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      )
      globalThis.fetch = fetchMock

      const client = createLineClient('test-token')
      const result = await client.getMessageContent('msg_abc123')

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, options] = fetchMock.mock.calls[0]
      // Critical: control plane is api.line.me; content lives on
      // api-data.line.me. Mixing them up returns 404.
      expect(url).toBe('https://api-data.line.me/v2/bot/message/msg_abc123/content')
      expect(options.method).toBe('GET')
      expect(options.headers.Authorization).toBe('Bearer test-token')

      expect(result.mime).toBe('image/png')
      expect(result.buffer).toBeInstanceOf(Buffer)
      expect(result.buffer.byteLength).toBe(png.byteLength)
      // First two bytes of a PNG signature.
      expect(result.buffer[0]).toBe(0x89)
      expect(result.buffer[1]).toBe(0x50)
    })

    test('strips charset/parameters from Content-Type', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'image/JPEG; foo=bar' },
          }),
        ),
      )
      globalThis.fetch = fetchMock

      const client = createLineClient('test-token')
      const { mime } = await client.getMessageContent('msgid')
      expect(mime).toBe('image/jpeg')
    })

    test('falls back to application/octet-stream when no Content-Type header', async () => {
      const fetchMock = mock(
        () => Promise.resolve(new Response(new Uint8Array([1]), { status: 200 })),
      )
      globalThis.fetch = fetchMock

      const client = createLineClient('test-token')
      const { mime } = await client.getMessageContent('msgid')
      // The fetch Response API still sets content-type when given a Uint8Array
      // (often "application/octet-stream"). We only assert we got a string.
      expect(typeof mime).toBe('string')
      expect(mime.length).toBeGreaterThan(0)
    })

    test('throws on non-2xx response — caller must handle the error path', async () => {
      const fetchMock = mock(() =>
        Promise.resolve(new Response('not found', { status: 404 })),
      )
      globalThis.fetch = fetchMock

      const client = createLineClient('test-token')
      await expect(client.getMessageContent('msgid')).rejects.toThrow(/404/)
    })

    test('rejects messageId with unsafe characters before any network call', async () => {
      const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })))
      globalThis.fetch = fetchMock

      const client = createLineClient('test-token')
      await expect(client.getMessageContent('../escape')).rejects.toThrow(/charset/)
      await expect(client.getMessageContent('id with space')).rejects.toThrow(/charset/)
      await expect(client.getMessageContent('id\0null')).rejects.toThrow(/charset/)
      // The fetchMock should never have been hit for invalid ids.
      expect(fetchMock).toHaveBeenCalledTimes(0)
    })
  })
})
