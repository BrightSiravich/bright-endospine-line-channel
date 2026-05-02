// src/image-store.ts
//
// Image storage helpers for the LINE Content API path.
//
// Sanitization boundary: image bytes and the `eventId` filename component
// arrive from LINE's webhook payload — they are USER-CONTROLLED data. Two
// invariants must hold here:
//
//   1. The file extension is decided ONLY by the response Content-Type (which
//      we pre-validate against an allowlist), never by anything the user sent.
//   2. The eventId is restricted to a safe charset before joining into a path,
//      so a hostile webhook can't escape the .images/ directory via "../" or
//      slashes. Any ambiguity → throw, don't sanitize-and-continue.
//
// Storage policy: files land in `<repoDir>/.images/<eventId>.<ext>`. The
// directory is gitignored and created on demand with mode 0700 (owner-only),
// so even if a bystander has shell access on the Mac Mini they can't read
// fetched images.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// MIME → file extension. Keep this list short and explicit; anything not in
// the map is rejected loudly so the caller can decide what to do.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg', // some servers send the non-canonical form
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export class UnsupportedImageTypeError extends Error {
  readonly mime: string
  constructor(mime: string) {
    super(`Unsupported image MIME type: ${mime}`)
    this.name = 'UnsupportedImageTypeError'
    this.mime = mime
  }
}

export class UnsafeEventIdError extends Error {
  readonly eventId: string
  constructor(eventId: string) {
    super(`Unsafe eventId for filesystem use: ${JSON.stringify(eventId)}`)
    this.name = 'UnsafeEventIdError'
    this.eventId = eventId
  }
}

/**
 * Map a LINE Content-Type header to a safe file extension.
 *
 * Throws `UnsupportedImageTypeError` for anything outside the allowlist —
 * the caller decides whether to log+drop or escalate. Choosing to throw
 * (rather than return null + a fallback `.bin`) means we never accidentally
 * persist an executable disguised as an image.
 */
export function extensionForMime(mime: string): string {
  const normalized = mime.toLowerCase().split(';')[0].trim()
  const ext = MIME_TO_EXT[normalized]
  if (!ext) throw new UnsupportedImageTypeError(normalized)
  return ext
}

/**
 * Validate that an eventId is safe to use as a filename component.
 *
 * LINE webhookEventIds are documented as opaque strings; in practice they're
 * URL-safe base64-style. We require [A-Za-z0-9_-]+ and reject anything else.
 */
export function assertSafeEventId(eventId: string): void {
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) {
    throw new UnsafeEventIdError(eventId)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(eventId)) {
    throw new UnsafeEventIdError(eventId)
  }
}

export interface ImageStoreOptions {
  /** Absolute path to the directory that should hold .images/. Usually the repo root. */
  baseDir: string
}

export interface SavedImage {
  /** Absolute path to the saved file. */
  path: string
  /** Extension without leading dot. */
  ext: string
  /** Bytes written. */
  size: number
}

export function createImageStore(options: ImageStoreOptions) {
  const dir = resolve(options.baseDir, '.images')

  function ensureDir(): void {
    // recursive:true is fine — mkdir is idempotent. mode 0700 = owner only.
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  /**
   * Persist image bytes for a webhook event. Filename is derived solely from
   * the validated eventId and mime — neither caller-supplied path nor user
   * caption ever influences disk layout.
   */
  function save(eventId: string, mime: string, buffer: Buffer): SavedImage {
    assertSafeEventId(eventId)
    const ext = extensionForMime(mime)
    ensureDir()
    const target = join(dir, `${eventId}.${ext}`)
    // Final defense-in-depth: the resolved target must still be inside `dir`.
    // assertSafeEventId already prevents traversal, but a bug in this function
    // could regress that. resolve+startsWith is cheap insurance.
    if (!resolve(target).startsWith(dir + '/') && resolve(target) !== dir) {
      throw new UnsafeEventIdError(eventId)
    }
    // mode 0600 = owner read/write only. Files might contain OR schedules with
    // patient PII; minimum surface area on the multiuser Mac Mini matters.
    writeFileSync(target, buffer, { mode: 0o600 })
    return { path: target, ext, size: buffer.byteLength }
  }

  return { save, dir }
}

export type ImageStore = ReturnType<typeof createImageStore>
