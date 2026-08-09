/**
 * The relay's entire wire contract, shared by the Worker, the Durable Object,
 * and the test suite. Clients (the Wolffish desktop and mobile apps) mirror
 * these constants in their tunnel protocol package.
 *
 * The contract in one paragraph: a client connects to
 * `wss://relay.wolffi.sh/t/<rid>?role=host|guest` where `rid` is a 64-char
 * lowercase-hex rendezvous ID derived from the pairing secret
 * (HMAC(pairing_secret, "rid-v1")). The relay pairs the two roles, tells each
 * side about the other's presence with tiny JSON text notices, and forwards
 * every binary frame verbatim to the opposite role. Binary frames are opaque
 * end-to-end-encrypted records — the relay never parses, stores, or logs them
 * — with ONE deliberate exception: records tagged with the CONTROL byte are
 * plaintext JSON addressed to the relay itself, carrying the push-notification
 * control plane defined at the bottom of this file. Those are parsed and
 * terminated here, never forwarded.
 */

/** Rendezvous IDs are exactly 256 bits, lowercase hex. Anything else is a 404. */
export const RID_REGEX = /^[0-9a-f]{64}$/

/** Path shape of the tunnel endpoint: /t/<rid> */
export const TUNNEL_PATH_REGEX = /^\/t\/([0-9a-f]{64})$/

/** The two ends of a tunnel. Desktop parks as `host`; mobile dials in as `guest`. */
export const ROLES = ['host', 'guest'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string | null): value is Role {
  return value === 'host' || value === 'guest'
}

export function peerOf(role: Role): Role {
  return role === 'host' ? 'guest' : 'host'
}

/**
 * Hard cap per relayed frame. Client chunking (256 KiB ciphertext records)
 * stays far below this; the cap exists so a misbehaving peer cannot shove
 * arbitrarily large frames through the relay.
 */
export const MAX_MESSAGE_BYTES = 1_048_576 // 1 MiB

/**
 * Transport-level keepalive, answered by the Workers runtime itself without
 * waking a hibernating Durable Object. This is deliberately plaintext: it
 * reveals only "this socket is alive", which the transport already reveals.
 * End-to-end liveness of the *peer* is the encrypted protocol's own PING frame.
 */
export const KEEPALIVE = { request: 'ping', response: 'pong' } as const

/** WebSocket readyState value for an open socket (workers runtime numeric). */
export const WS_OPEN = 1

/**
 * Application close codes (4000–4999 range is reserved for applications).
 * Everything the relay does on purpose is one of these; anything else a client
 * sees is transport weather.
 */
export const CloseCode = {
  /** A newer connection for the same role arrived; this socket was evicted. */
  Replaced: 4000,
  /** Client sent a text frame other than the keepalive. Clients speak binary only. */
  ProtocolViolation: 4400,
  /** Client sent a frame larger than MAX_MESSAGE_BYTES. */
  MessageTooLarge: 4413
} as const

/**
 * Relay → client presence notices. These are the only text frames the relay
 * ever sends (besides the runtime's auto keepalive response), so clients can
 * dispatch on frame type alone: text = relay notice, binary = peer data.
 */
export type Notice = { t: 'peer-present' } | { t: 'peer-gone' }

export function notice(t: Notice['t']): string {
  return JSON.stringify({ t })
}

// ---------------------------------------------------------------------------
// Push-notification control plane
// ---------------------------------------------------------------------------
//
// Binary records between the clients carry a one-byte type prefix (the same
// marker a TLS record header exposes): 0x01 handshake, 0x02 sealed transport.
// Those two are and remain OPAQUE — the relay forwards them verbatim and never
// looks past byte 0. Records tagged 0x03 are different by design: they are
// plaintext JSON control frames ADDRESSED TO THE RELAY, never forwarded, and
// they exist so the relay can deliver push notifications when the phone is
// away. This is the one part of the wire the relay is meant to read; clients
// choose what enters it (notification titles/bodies and push registrations —
// never conversation content, which stays on the sealed 0x02 plane).
//
// Version-skew story: an old relay forwards 0x03 records like any other
// binary frame, and both clients silently drop record types they don't know —
// so a new app against an old (e.g. self-hosted) relay degrades to "no push",
// never to a broken tunnel. An old app against this relay simply never sends
// 0x03.

/** First byte of a control record. Bytes 1.. are UTF-8 JSON. */
export const CONTROL_RECORD = 0x03

/** Control frames are tiny; anything larger is malformed by construction. */
export const MAX_CONTROL_BYTES = 4096

export const PUSH_WIRE_VERSION = 1

export const NOTIFY_PHASES = ['started', 'needs_input', 'failed', 'completed', 'info'] as const
export type NotifyPhase = (typeof NOTIFY_PHASES)[number]

export const NOTIFY_URGENCIES = ['normal', 'high'] as const
export type NotifyUrgency = (typeof NOTIFY_URGENCIES)[number]

export type PushPlatform = 'ios' | 'android'

export const NOTIFY_TITLE_MAX = 60
export const NOTIFY_BODY_MAX = 180
export const NOTIFY_TTL_MIN = 60
export const NOTIFY_TTL_MAX = 86_400

/** Ceiling for the per-device unread badge count. Purely a sanity clamp —
 *  no OS renders a bigger number meaningfully. */
export const BADGE_COUNT_MAX = 999

/** How long an in-band delivery waits for the phone's ack before the relay
 *  falls back to Expo push. Overridable per-env for tests only. */
export const NOTIFY_ACK_TIMEOUT_MS = 2_000

/** Push receipts become available shortly after a send; 15 minutes is Expo's
 *  own recommended check-back interval. */
export const RECEIPT_SWEEP_DELAY_MS = 15 * 60_000

/** How long a processed notificationId is remembered for idempotency. Far
 *  beyond the largest allowed ttl, after which a duplicate is nonsensical. */
export const NOTIFY_DEDUP_RETENTION_MS = 24 * 3_600_000

/** Android notification channel; must match what the mobile app creates. */
export const ANDROID_CHANNEL_ID = 'agent-runs'

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
/** Expo accepts at most this many messages / receipt ids per request. */
export const EXPO_BATCH_LIMIT = 100

/** Phone → relay, on pairing and on every app foreground. */
export type RegisterPushFrame = {
  v: 1
  type: 'register_push'
  /** Stable per-device id minted by the phone. NOT the rendezvous or session
   *  id (both ephemeral), and not derived from the phone's identity key. */
  phoneId: string
  /** Null when notification permission was denied — delivery then degrades
   *  to in-band only. */
  expoPushToken: string | null
  platform: PushPlatform
  appVersion?: string | null
}

/** Desktop → relay, when the model calls the notify tool. */
export type NotifyFrame = {
  v: 1
  type: 'notify'
  /** ULID, generated by the desktop — never by the model. */
  notificationId: string
  /** From the desktop's pairing record — never from the model. */
  phoneId: string
  runId: string
  phase: NotifyPhase
  title: string
  body: string
  urgency: NotifyUrgency
  deeplink: string | null
  /** Seconds. */
  ttl: number
  /** Unix ms at the desktop. */
  ts: number
}

/** Relay → phone, in-band delivery: the notify frame under another type. */
export type NotificationFrame = Omit<NotifyFrame, 'type'> & { type: 'notification' }

/** Phone → relay: the in-band delivery arrived and was rendered. */
export type NotificationAckFrame = { v: 1; type: 'notification_ack'; notificationId: string }

/**
 * Phone → relay: the phone's current unread notification count, absolute.
 * The relay keeps one integer per device so the Expo push fallback can stamp
 * an accurate `badge` onto OS notifications while the app is dead; the phone
 * owns the real per-conversation state and overwrites this number whenever it
 * changes locally (conversation opened, notification seen). Absolute rather
 * than a delta so a lost or reordered frame can never make the count drift.
 */
export type SetBadgeFrame = {
  v: 1
  type: 'set_badge'
  phoneId: string
  count: number
}

/** Relay → desktop: how the notify was routed, answered immediately. */
export type NotifyResultFrame = {
  v: 1
  type: 'notify_result'
  /** Null only when the frame was too malformed to carry an id. */
  notificationId: string | null
  route: 'inband' | 'push' | 'dropped'
  /** Present when dropped (and on validation rejects). */
  reason?: string
}

/** Frame under [CONTROL_RECORD, ...utf8 json]. */
export function encodeControlRecord(frame: Record<string, unknown>): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(frame))
  const record = new Uint8Array(1 + body.length)
  record[0] = CONTROL_RECORD
  record.set(body, 1)
  return record
}

/**
 * The JSON body of a control record, or null when it isn't one we should
 * try to read (wrong tag, oversized, or not JSON). Callers still validate
 * every field — this only gets the bytes into object shape.
 */
export function decodeControlRecord(record: Uint8Array): Record<string, unknown> | null {
  if (record.length < 2 || record[0] !== CONTROL_RECORD) return null
  if (record.length > MAX_CONTROL_BYTES) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(record.subarray(1)))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Stable device ids: hex/uuid-ish, bounded. */
const PHONE_ID_REGEX = /^[A-Za-z0-9_.-]{8,128}$/

/** ULIDs as the desktop mints them: 26 Crockford base32 chars. */
const NOTIFICATION_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** `ExponentPushToken[…]` / `ExpoPushToken[…]`, printable, bounded. */
const PUSH_TOKEN_REGEX = /^Expo(nent)?PushToken\[[\x21-\x7e]{1,180}\]$/

const RUN_ID_REGEX = /^[\x20-\x7e]{1,128}$/

export function isValidPhoneId(value: unknown): value is string {
  return typeof value === 'string' && PHONE_ID_REGEX.test(value)
}

export function isValidNotificationId(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_ID_REGEX.test(value)
}

export function isValidExpoPushToken(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && PUSH_TOKEN_REGEX.test(value)
}

/** Deep links must stay inside the app's own scheme. */
export function isValidDeeplink(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    value.startsWith('wolffish://') &&
    // eslint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f\s]/.test(value)
  )
}

/** No control characters at all — titles are one line by contract. */
// eslint-disable-next-line no-control-regex
const TITLE_FORBIDDEN = /[\x00-\x1f\x7f]/
/** Bodies may wrap (\n) but carry no other control characters. */
// eslint-disable-next-line no-control-regex
const BODY_FORBIDDEN = /[\x00-\x09\x0b-\x1f\x7f]/

export type ParseResult<T> = { frame: T } | { error: string }

/**
 * Validate a register_push frame. Strings are rejected rather than repaired:
 * the sender is our own app and a malformed frame means a bug worth surfacing,
 * not something to paper over.
 */
export function parseRegisterPush(raw: Record<string, unknown>): ParseResult<RegisterPushFrame> {
  if (raw.v !== PUSH_WIRE_VERSION) return { error: `unsupported version ${String(raw.v)}` }
  if (!isValidPhoneId(raw.phoneId)) return { error: 'invalid phoneId' }
  if (raw.platform !== 'ios' && raw.platform !== 'android') return { error: 'invalid platform' }
  let token: string | null
  if (raw.expoPushToken === null || raw.expoPushToken === undefined) token = null
  else if (isValidExpoPushToken(raw.expoPushToken)) token = raw.expoPushToken
  else return { error: 'invalid expoPushToken' }
  const appVersion =
    typeof raw.appVersion === 'string' && raw.appVersion.length <= 32 ? raw.appVersion : null
  return {
    frame: {
      v: 1,
      type: 'register_push',
      phoneId: raw.phoneId,
      expoPushToken: token,
      platform: raw.platform,
      appVersion
    }
  }
}

/**
 * Validate a notify frame. Oversized or malformed strings are REJECTED, not
 * truncated — silent truncation would deliver a notification the desktop
 * never composed. The numeric ttl alone is clamped into range.
 */
export function parseNotify(raw: Record<string, unknown>): ParseResult<NotifyFrame> {
  if (raw.v !== PUSH_WIRE_VERSION) return { error: `unsupported version ${String(raw.v)}` }
  if (!isValidNotificationId(raw.notificationId)) return { error: 'invalid notificationId' }
  if (!isValidPhoneId(raw.phoneId)) return { error: 'invalid phoneId' }
  if (typeof raw.runId !== 'string' || !RUN_ID_REGEX.test(raw.runId)) {
    return { error: 'invalid runId' }
  }
  if (!NOTIFY_PHASES.includes(raw.phase as NotifyPhase)) return { error: 'invalid phase' }
  if (typeof raw.title !== 'string' || raw.title.length === 0) return { error: 'missing title' }
  if (raw.title.length > NOTIFY_TITLE_MAX) return { error: `title exceeds ${NOTIFY_TITLE_MAX}` }
  if (TITLE_FORBIDDEN.test(raw.title)) return { error: 'title carries control characters' }
  if (typeof raw.body !== 'string' || raw.body.length === 0) return { error: 'missing body' }
  if (raw.body.length > NOTIFY_BODY_MAX) return { error: `body exceeds ${NOTIFY_BODY_MAX}` }
  if (BODY_FORBIDDEN.test(raw.body)) return { error: 'body carries control characters' }
  if (!NOTIFY_URGENCIES.includes(raw.urgency as NotifyUrgency)) return { error: 'invalid urgency' }
  let deeplink: string | null
  if (raw.deeplink === null || raw.deeplink === undefined) deeplink = null
  else if (isValidDeeplink(raw.deeplink)) deeplink = raw.deeplink
  else return { error: 'invalid deeplink' }
  if (typeof raw.ttl !== 'number' || !Number.isFinite(raw.ttl)) return { error: 'invalid ttl' }
  const ttl = Math.min(NOTIFY_TTL_MAX, Math.max(NOTIFY_TTL_MIN, Math.round(raw.ttl)))
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : Date.now()
  return {
    frame: {
      v: 1,
      type: 'notify',
      notificationId: raw.notificationId,
      phoneId: raw.phoneId,
      runId: raw.runId,
      phase: raw.phase as NotifyPhase,
      title: raw.title,
      body: raw.body,
      urgency: raw.urgency as NotifyUrgency,
      deeplink,
      ttl,
      ts
    }
  }
}

export function parseNotificationAck(
  raw: Record<string, unknown>
): ParseResult<NotificationAckFrame> {
  if (raw.v !== PUSH_WIRE_VERSION) return { error: `unsupported version ${String(raw.v)}` }
  if (!isValidNotificationId(raw.notificationId)) return { error: 'invalid notificationId' }
  return { frame: { v: 1, type: 'notification_ack', notificationId: raw.notificationId } }
}

/** Validate a set_badge frame. Like ttl, the count is a number the relay
 *  clamps into range rather than rejects — it is a rendering hint, not data. */
export function parseSetBadge(raw: Record<string, unknown>): ParseResult<SetBadgeFrame> {
  if (raw.v !== PUSH_WIRE_VERSION) return { error: `unsupported version ${String(raw.v)}` }
  if (!isValidPhoneId(raw.phoneId)) return { error: 'invalid phoneId' }
  if (typeof raw.count !== 'number' || !Number.isFinite(raw.count)) {
    return { error: 'invalid count' }
  }
  const count = Math.min(BADGE_COUNT_MAX, Math.max(0, Math.round(raw.count)))
  return { frame: { v: 1, type: 'set_badge', phoneId: raw.phoneId, count } }
}

/** Log-safe form of a push token: enough prefix to correlate, never the key. */
export function tokenPrefix(token: string | null): string {
  if (!token) return 'none'
  return `${token.slice(0, 22)}…`
}
