import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { AccessConfig, AllowedUser, PairingState } from './types'

const PAIRING_EXPIRY_MS = 60 * 60 * 1000 // 1 hour
const MAX_PAIRING_ATTEMPTS = 2

function generateCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let code = ''
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  for (const b of bytes) {
    code += chars[b % chars.length]
  }
  return code
}

export async function createAccessControl(filePath: string) {
  let config: AccessConfig = { mode: 'pairing', allowed_users: [] }
  let pairingState: PairingState | null = null

  // Load existing config
  try {
    const data = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(data)
    if (parsed.mode && Array.isArray(parsed.allowed_users)) {
      config = parsed
    }
  } catch {
    // File doesn't exist yet, use defaults
  }

  function getMode() {
    return config.mode
  }

  function setMode(mode: AccessConfig['mode']) {
    config.mode = mode
  }

  function isAllowed(userId: string): boolean {
    if (config.mode === 'disabled') return false
    return config.allowed_users.some((u) => u.id === userId)
  }

  function addUser(userId: string, name: string) {
    if (!config.allowed_users.some((u) => u.id === userId)) {
      config.allowed_users.push({
        id: userId,
        name,
        paired_at: new Date().toISOString(),
      })
    }
    config.mode = 'allowlist'
    pairingState = null
  }

  function removeUser(userId: string) {
    config.allowed_users = config.allowed_users.filter((u) => u.id !== userId)
  }

  function listUsers(): AllowedUser[] {
    return [...config.allowed_users]
  }

  function startPairing(
    userId: string,
  ): { code: string; error?: undefined } | { code?: undefined; error: string } {
    // Reject if another user is already pairing
    if (pairingState && pairingState.userId !== userId) {
      if (Date.now() - pairingState.createdAt < PAIRING_EXPIRY_MS) {
        return { error: 'pairing_in_progress' }
      }
      pairingState = null
    }

    // Check attempt limit for same user
    if (pairingState && pairingState.userId === userId) {
      if (pairingState.attempts >= MAX_PAIRING_ATTEMPTS) {
        return { error: 'too_many_attempts' }
      }
      pairingState.attempts++
      pairingState.code = generateCode()
      pairingState.createdAt = Date.now()
      return { code: pairingState.code }
    }

    // New pairing
    const code = generateCode()
    pairingState = { userId, code, createdAt: Date.now(), attempts: 1 }
    return { code }
  }

  function verifyPairing(
    code: string,
  ): { success: true; userId: string } | { success: false; error: string } {
    if (!pairingState) {
      return { success: false, error: 'no_pending_pairing' }
    }
    if (Date.now() - pairingState.createdAt >= PAIRING_EXPIRY_MS) {
      pairingState = null
      return { success: false, error: 'expired' }
    }
    if (pairingState.code !== code) {
      return { success: false, error: 'invalid_code' }
    }
    const userId = pairingState.userId
    addUser(userId, userId)
    return { success: true, userId }
  }

  async function save() {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(config, null, 2))
  }

  function _expirePairingForTest() {
    if (pairingState) {
      pairingState.createdAt = Date.now() - PAIRING_EXPIRY_MS - 1
    }
  }

  return {
    getMode,
    setMode,
    isAllowed,
    addUser,
    removeUser,
    listUsers,
    startPairing,
    verifyPairing,
    save,
    _expirePairingForTest,
  }
}

export type AccessControl = Awaited<ReturnType<typeof createAccessControl>>
