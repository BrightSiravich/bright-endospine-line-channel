import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { createAccessControl } from '../src/access-control'
import { join } from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'

describe('AccessControl', () => {
  let tempDir: string
  let accessPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'line-test-'))
    accessPath = join(tempDir, 'access.json')
  })

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  test('initial mode is pairing', async () => {
    const ac = await createAccessControl(accessPath)
    expect(ac.getMode()).toBe('pairing')
  })

  test('isAllowed returns false for unknown user in pairing mode', async () => {
    const ac = await createAccessControl(accessPath)
    expect(ac.isAllowed('U_unknown')).toBe(false)
  })

  test('isAllowed returns true for paired user', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    expect(ac.isAllowed('U_test')).toBe(true)
  })

  test('addUser switches mode to allowlist', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    expect(ac.getMode()).toBe('allowlist')
  })

  test('startPairing generates 6-char code', async () => {
    const ac = await createAccessControl(accessPath)
    const result = ac.startPairing('U_new')
    expect(result.code).toHaveLength(6)
    expect(result.code).toMatch(/^[a-z0-9]{6}$/)
  })

  test('startPairing limits attempts to 2', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_new')
    ac.startPairing('U_new')
    const third = ac.startPairing('U_new')
    expect(third.error).toBe('too_many_attempts')
  })

  test('verifyPairing succeeds with correct code', async () => {
    const ac = await createAccessControl(accessPath)
    const { code } = ac.startPairing('U_new') as { code: string }
    const result = ac.verifyPairing(code)
    expect(result.success).toBe(true)
    expect(ac.isAllowed('U_new')).toBe(true)
  })

  test('verifyPairing fails with wrong code', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_new')
    const result = ac.verifyPairing('wrong1')
    expect(result.success).toBe(false)
  })

  test('pairing code expires after 1 hour', async () => {
    const ac = await createAccessControl(accessPath)
    const { code } = ac.startPairing('U_new') as { code: string }
    ac._expirePairingForTest()
    const result = ac.verifyPairing(code)
    expect(result.success).toBe(false)
    expect(result.error).toBe('expired')
  })

  test('concurrent pairing rejects second user', async () => {
    const ac = await createAccessControl(accessPath)
    ac.startPairing('U_first')
    const result = ac.startPairing('U_second')
    expect(result.error).toBe('pairing_in_progress')
  })

  test('disabled mode rejects all users', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    ac.setMode('disabled')
    expect(ac.isAllowed('U_test')).toBe(false)
  })

  test('persists to file', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    await ac.save()

    const ac2 = await createAccessControl(accessPath)
    expect(ac2.isAllowed('U_test')).toBe(true)
    expect(ac2.getMode()).toBe('allowlist')
  })

  test('removeUser removes from allowlist', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_test', 'TestUser')
    ac.removeUser('U_test')
    expect(ac.isAllowed('U_test')).toBe(false)
  })

  test('listUsers returns allowed users', async () => {
    const ac = await createAccessControl(accessPath)
    ac.addUser('U_a', 'Alice')
    ac.addUser('U_b', 'Bob')
    const users = ac.listUsers()
    expect(users).toHaveLength(2)
    expect(users[0].id).toBe('U_a')
    expect(users[1].id).toBe('U_b')
  })
})
