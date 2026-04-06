export async function verifySignature(
  body: string,
  secret: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )

  let sigBuf: Uint8Array
  try {
    sigBuf = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0))
  } catch {
    return false
  }

  return crypto.subtle.verify('HMAC', key, sigBuf.buffer as ArrayBuffer, encoder.encode(body))
}
