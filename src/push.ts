/**
 * Expo push API client — plain fetch, no SDK.
 *
 * Two endpoints, both batched at Expo's documented ceiling of 100 items per
 * request: `push/send` turns messages into tickets, `push/getReceipts` turns
 * ticket ids into delivery receipts. The Expo project has Enhanced Security
 * for Push Notifications enabled, which makes the Authorization header
 * load-bearing: a missing or wrong EXPO_ACCESS_TOKEN fails EVERY send, so
 * auth failures are logged loudly and distinctly rather than folded into
 * generic transport errors.
 *
 * This file only talks HTTP. What to do about each ticket/receipt (persist,
 * prune a device, re-arm an alarm) is the Tunnel DO's business.
 */
import { EXPO_BATCH_LIMIT, EXPO_PUSH_URL, EXPO_RECEIPTS_URL } from './protocol'
import type { Env } from './types'

/** One message in the shape POST push/send expects. */
export type ExpoPushMessage = {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound: 'default'
  priority: 'default' | 'high'
  /** Seconds. */
  ttl: number
  channelId: string
}

export type ExpoTicket =
  { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: { error?: string } }

export type ExpoReceipt =
  { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } }

function headers(env: Env): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}`
  }
}

/**
 * A 401/403 from exp.host means the access token is missing, revoked, or
 * wrong — with Enhanced Security on, that is total push outage, not a blip.
 */
function logIfAuthFailure(status: number, what: string): boolean {
  if (status !== 401 && status !== 403) return false
  console.error(
    `[push] EXPO AUTH ERROR (${status}) on ${what} — EXPO_ACCESS_TOKEN is missing or invalid; ` +
      'Enhanced Security rejects every unauthenticated call, so no push will deliver until the ' +
      'secret is fixed (wrangler secret put EXPO_ACCESS_TOKEN)'
  )
  return true
}

/**
 * Send push messages, batched. Returns one ticket per message, in order, or
 * null for a batch that failed at the transport/HTTP layer (those messages
 * produced no tickets at all).
 */
export async function sendExpoPush(
  env: Env,
  messages: ExpoPushMessage[]
): Promise<(ExpoTicket | null)[]> {
  const tickets: (ExpoTicket | null)[] = []
  for (let i = 0; i < messages.length; i += EXPO_BATCH_LIMIT) {
    const batch = messages.slice(i, i + EXPO_BATCH_LIMIT)
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: headers(env),
        body: JSON.stringify(batch)
      })
      if (!response.ok) {
        if (!logIfAuthFailure(response.status, 'push/send')) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          console.error(`[push] push/send failed with HTTP ${response.status}: ${detail}`)
        }
        tickets.push(...batch.map(() => null))
        continue
      }
      const payload = (await response.json()) as { data?: ExpoTicket[] }
      const data = Array.isArray(payload.data) ? payload.data : []
      for (let j = 0; j < batch.length; j += 1) tickets.push(data[j] ?? null)
    } catch (error) {
      console.error(`[push] push/send network failure: ${String(error)}`)
      tickets.push(...batch.map(() => null))
    }
  }
  return tickets
}

/**
 * Fetch receipts for ticket ids, batched and merged. Returns null when EVERY
 * batch failed (caller should keep its tickets and retry next sweep); a
 * partial map when at least one batch answered.
 */
export async function getExpoReceipts(
  env: Env,
  ticketIds: string[]
): Promise<Record<string, ExpoReceipt> | null> {
  const receipts: Record<string, ExpoReceipt> = {}
  let anySuccess = false
  for (let i = 0; i < ticketIds.length; i += EXPO_BATCH_LIMIT) {
    const batch = ticketIds.slice(i, i + EXPO_BATCH_LIMIT)
    try {
      const response = await fetch(EXPO_RECEIPTS_URL, {
        method: 'POST',
        headers: headers(env),
        body: JSON.stringify({ ids: batch })
      })
      if (!response.ok) {
        if (!logIfAuthFailure(response.status, 'push/getReceipts')) {
          const detail = (await response.text().catch(() => '')).slice(0, 300)
          console.error(`[push] push/getReceipts failed with HTTP ${response.status}: ${detail}`)
        }
        continue
      }
      const payload = (await response.json()) as { data?: Record<string, ExpoReceipt> }
      Object.assign(receipts, payload.data ?? {})
      anySuccess = true
    } catch (error) {
      console.error(`[push] push/getReceipts network failure: ${String(error)}`)
    }
  }
  return anySuccess ? receipts : null
}
