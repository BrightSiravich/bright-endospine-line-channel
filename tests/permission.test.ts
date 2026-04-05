import { describe, expect, test } from 'bun:test'
import { parseVerdict, formatPermissionRequest } from '../src/permission'

describe('parseVerdict', () => {
  test('parses "yes abcde"', () => {
    const result = parseVerdict('yes abcde')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('parses "no fghij"', () => {
    const result = parseVerdict('no fghij')
    expect(result).toEqual({ behavior: 'deny', requestId: 'fghij' })
  })

  test('parses shorthand "y abcde"', () => {
    const result = parseVerdict('y abcde')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('parses shorthand "n abcde"', () => {
    const result = parseVerdict('n abcde')
    expect(result).toEqual({ behavior: 'deny', requestId: 'abcde' })
  })

  test('tolerates leading/trailing whitespace', () => {
    const result = parseVerdict('  yes abcde  ')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('case insensitive', () => {
    const result = parseVerdict('YES ABCDE')
    expect(result).toEqual({ behavior: 'allow', requestId: 'abcde' })
  })

  test('rejects request_id containing "l"', () => {
    const result = parseVerdict('yes abcle')
    expect(result).toBeNull()
  })

  test('rejects wrong length request_id', () => {
    const result = parseVerdict('yes abc')
    expect(result).toBeNull()
  })

  test('returns null for non-verdict text', () => {
    const result = parseVerdict('Hello, how are you?')
    expect(result).toBeNull()
  })

  test('returns null for empty string', () => {
    const result = parseVerdict('')
    expect(result).toBeNull()
  })
})

describe('formatPermissionRequest', () => {
  test('formats permission request message', () => {
    const msg = formatPermissionRequest({
      request_id: 'abcde',
      tool_name: 'Bash',
      description: 'Run a shell command',
      input_preview: '{"command":"ls -la"}',
    })
    expect(msg).toContain('Bash')
    expect(msg).toContain('Run a shell command')
    expect(msg).toContain('ls -la')
    expect(msg).toContain('yes abcde')
    expect(msg).toContain('no abcde')
  })
})
