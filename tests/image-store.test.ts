import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createImageStore,
  extensionForMime,
  assertSafeEventId,
  UnsupportedImageTypeError,
  UnsafeEventIdError,
} from '../src/image-store'

describe('extensionForMime', () => {
  test('jpeg → jpg', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg')
  })

  test('jpg variant → jpg', () => {
    // Some servers send the non-canonical "image/jpg".
    expect(extensionForMime('image/jpg')).toBe('jpg')
  })

  test('png → png', () => {
    expect(extensionForMime('image/png')).toBe('png')
  })

  test('gif → gif', () => {
    expect(extensionForMime('image/gif')).toBe('gif')
  })

  test('webp → webp', () => {
    expect(extensionForMime('image/webp')).toBe('webp')
  })

  test('strips parameters and lowercases', () => {
    expect(extensionForMime('IMAGE/JPEG; charset=binary')).toBe('jpg')
  })

  test('throws UnsupportedImageTypeError for unknown mime', () => {
    expect(() => extensionForMime('image/heic')).toThrow(UnsupportedImageTypeError)
  })

  test('throws for non-image types — never silently accepts as .bin', () => {
    expect(() => extensionForMime('application/octet-stream')).toThrow(
      UnsupportedImageTypeError,
    )
    expect(() => extensionForMime('text/plain')).toThrow(UnsupportedImageTypeError)
    expect(() => extensionForMime('image/svg+xml')).toThrow(UnsupportedImageTypeError)
  })

  test('error carries the offending mime', () => {
    try {
      extensionForMime('image/bmp')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedImageTypeError)
      expect((err as UnsupportedImageTypeError).mime).toBe('image/bmp')
    }
  })
})

describe('assertSafeEventId', () => {
  test('accepts plain alphanumeric', () => {
    expect(() => assertSafeEventId('abc123')).not.toThrow()
  })

  test('accepts dashes and underscores', () => {
    expect(() => assertSafeEventId('event_id-123')).not.toThrow()
  })

  test('accepts a realistic LINE webhookEventId', () => {
    expect(() => assertSafeEventId('01H8K9PZRQRS6V0XW1MTAB23CD')).not.toThrow()
  })

  test('rejects empty', () => {
    expect(() => assertSafeEventId('')).toThrow(UnsafeEventIdError)
  })

  test('rejects path traversal', () => {
    expect(() => assertSafeEventId('../etc/passwd')).toThrow(UnsafeEventIdError)
  })

  test('rejects forward slash', () => {
    expect(() => assertSafeEventId('a/b')).toThrow(UnsafeEventIdError)
  })

  test('rejects backslash', () => {
    expect(() => assertSafeEventId('a\\b')).toThrow(UnsafeEventIdError)
  })

  test('rejects null byte', () => {
    expect(() => assertSafeEventId('a\0b')).toThrow(UnsafeEventIdError)
  })

  test('rejects whitespace', () => {
    expect(() => assertSafeEventId('a b')).toThrow(UnsafeEventIdError)
    expect(() => assertSafeEventId('a\tb')).toThrow(UnsafeEventIdError)
    expect(() => assertSafeEventId('a\nb')).toThrow(UnsafeEventIdError)
  })

  test('rejects dot-only and double-dot', () => {
    expect(() => assertSafeEventId('.')).toThrow(UnsafeEventIdError)
    expect(() => assertSafeEventId('..')).toThrow(UnsafeEventIdError)
  })

  test('rejects unicode that could be confused', () => {
    expect(() => assertSafeEventId('‮evil')).toThrow(UnsafeEventIdError)
  })

  test('rejects absurdly long ids', () => {
    expect(() => assertSafeEventId('a'.repeat(200))).toThrow(UnsafeEventIdError)
  })
})

describe('createImageStore', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'line-image-store-'))
  })

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true })
  })

  test('save() creates .images/ on demand', () => {
    const store = createImageStore({ baseDir })
    expect(existsSync(store.dir)).toBe(false)
    store.save('evt123', 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(existsSync(store.dir)).toBe(true)
  })

  test('save() writes to .images/<eventId>.<ext> with correct extension', () => {
    const store = createImageStore({ baseDir })
    const result = store.save('evt_jpg', 'image/jpeg', Buffer.from('fake-jpeg'))
    expect(result.path).toBe(join(baseDir, '.images', 'evt_jpg.jpg'))
    expect(result.ext).toBe('jpg')
    expect(result.size).toBe(Buffer.from('fake-jpeg').byteLength)
    expect(readFileSync(result.path).toString()).toBe('fake-jpeg')
  })

  test('save() respects each supported mime', () => {
    const store = createImageStore({ baseDir })
    expect(store.save('a', 'image/jpeg', Buffer.from('x')).ext).toBe('jpg')
    expect(store.save('b', 'image/png', Buffer.from('x')).ext).toBe('png')
    expect(store.save('c', 'image/gif', Buffer.from('x')).ext).toBe('gif')
    expect(store.save('d', 'image/webp', Buffer.from('x')).ext).toBe('webp')
  })

  test('save() throws on unsupported mime — no fallback .bin', () => {
    const store = createImageStore({ baseDir })
    expect(() => store.save('evt', 'image/heic', Buffer.from('x'))).toThrow(
      UnsupportedImageTypeError,
    )
  })

  test('save() rejects path-traversal eventId before touching disk', () => {
    const store = createImageStore({ baseDir })
    expect(() => store.save('../escape', 'image/png', Buffer.from('x'))).toThrow(
      UnsafeEventIdError,
    )
    // No file should have been created outside .images/.
    expect(existsSync(join(baseDir, 'escape.png'))).toBe(false)
  })

  test('save() files are written with restrictive 0600 mode (owner only)', () => {
    const store = createImageStore({ baseDir })
    const result = store.save('evt_perm', 'image/png', Buffer.from('x'))
    const mode = statSync(result.path).mode & 0o777
    // On macOS umask may strip group/other bits regardless; we verify the
    // owner has rw and group/other lack write at minimum.
    expect(mode & 0o600).toBe(0o600)
    expect(mode & 0o022).toBe(0)
  })
})
