const PUSH_API_URL = 'https://api.line.me/v2/bot/message/push'
const WEBHOOK_ENDPOINT_URL = 'https://api.line.me/v2/bot/channel/webhook/endpoint'
const WEBHOOK_TEST_URL = 'https://api.line.me/v2/bot/channel/webhook/test'
const MAX_TEXT_LENGTH = 5000

// LINE free plan limit: 200 push messages per month.
// messageCount below is session-scoped (resets on process restart),
// so this is a coarse warning, not a precise monthly tracker.
// For accurate monthly usage, query LINE's quota API or persist to disk.
const LINE_FREE_PLAN_MONTHLY_LIMIT = 200
const RATE_LIMIT_WARN_THRESHOLD = 150

export function splitText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength))
  }
  return chunks
}

export function createLineClient(accessToken: string) {
  let messageCount = 0
  let warnedAtThreshold = false

  function recordMessageAndMaybeWarn(): void {
    messageCount++
    if (messageCount === RATE_LIMIT_WARN_THRESHOLD && !warnedAtThreshold) {
      warnedAtThreshold = true
      console.error(
        `[line] WARNING: ${messageCount} push messages sent this session. ` +
        `LINE free plan limit is ${LINE_FREE_PLAN_MONTHLY_LIMIT}/month. ` +
        `Approaching limit — monitor closely or upgrade LINE plan.`,
      )
    } else if (messageCount % 50 === 0) {
      console.error(`[line] ${messageCount} messages sent this session`)
    }
  }

  async function pushMessage(userId: string, text: string): Promise<void> {
    const chunks = splitText(text, MAX_TEXT_LENGTH)
    for (const chunk of chunks) {
      const res = await fetch(PUSH_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          to: userId,
          messages: [{ type: 'text', text: chunk }],
        }),
      })
      recordMessageAndMaybeWarn()
      if (!res.ok) {
        const body = await res.text()
        console.error(`[line] Push API error (${res.status}): ${body}`)
      }
    }
  }

  async function pushRawMessages(userId: string, messages: unknown[]): Promise<void> {
    const res = await fetch(PUSH_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    })
    recordMessageAndMaybeWarn()
    if (!res.ok) {
      const body = await res.text()
      console.error(`[line] Push API error (${res.status}): ${body}`)
    }
  }

  async function setWebhookUrl(endpoint: string): Promise<boolean> {
    const res = await fetch(WEBHOOK_ENDPOINT_URL, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ endpoint }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[line] Failed to set webhook URL (${res.status}): ${body}`)
      return false
    }
    return true
  }

  async function getWebhookUrl(): Promise<string | null> {
    const res = await fetch(WEBHOOK_ENDPOINT_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const data = await res.json() as { endpoint: string; active: boolean }
    return data.endpoint
  }

  async function testWebhook(): Promise<{ success: boolean; statusCode?: number; reason?: string }> {
    const res = await fetch(WEBHOOK_TEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({}),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error(`[line] Webhook test request failed (${res.status}): ${body}`)
      return { success: false }
    }
    const data = await res.json() as { success: boolean; statusCode: number; reason: string }
    return data
  }

  return { pushMessage, pushRawMessages, setWebhookUrl, getWebhookUrl, testWebhook }
}

export type LineClient = ReturnType<typeof createLineClient>
