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
 * end-to-end-encrypted records — the relay never parses, stores, or logs them.
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
