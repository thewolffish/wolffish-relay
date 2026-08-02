import {
  CloseCode,
  KEEPALIVE,
  MAX_MESSAGE_BYTES,
  WS_OPEN,
  isRole,
  notice,
  peerOf,
  type Role
} from './protocol'
import type { Env } from './types'

/**
 * Data attached to each socket. This is the ONLY state the relay keeps, and it
 * lives inside the WebSocket connection itself (surviving hibernation there) —
 * never in instance fields, never in storage. When the last socket closes,
 * nothing remains anywhere.
 */
interface Attachment {
  role: Role
  /** Set on a socket just before it is evicted by a newer connection for the
   * same role, so its close handler knows not to report the peer as gone. */
  replaced?: true
}

/**
 * One Tunnel instance exists per rendezvous ID (Durable Objects guarantee a
 * single global instance per name). It holds at most two live sockets — one
 * `host`, one `guest` — and forwards binary frames verbatim between them.
 *
 * Zero-retention by construction:
 * - no storage API calls anywhere in this class (`ctx.storage` is never touched)
 * - no logging, no analytics, no external fetches
 * - frames are forwarded, never parsed or buffered beyond the send in flight
 * - uses the WebSocket Hibernation API, so an idle tunnel is evicted from
 *   memory entirely; per-socket role survives inside the connection attachment
 */
export class Tunnel implements DurableObject {
  private readonly ctx: DurableObjectState

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx
    // The runtime answers transport keepalives itself, without waking a
    // hibernating object. Anything else a client sends as text is a violation.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(KEEPALIVE.request, KEEPALIVE.response)
    )
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role')
    if (!isRole(role)) return new Response('role must be host or guest', { status: 400 })

    // One live socket per role: a reconnect evicts its predecessor. The
    // `replaced` mark keeps the eviction from being misreported as the peer
    // leaving, regardless of when the close handler runs.
    for (const stale of this.ctx.getWebSockets(role)) {
      stale.serializeAttachment({ role, replaced: true } satisfies Attachment)
      this.tryClose(stale, CloseCode.Replaced, 'replaced by a newer connection')
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [role])
    server.serializeAttachment({ role } satisfies Attachment)

    const peers = this.livePeers(role)
    if (peers.length > 0) {
      this.trySend(server, notice('peer-present'))
      for (const peer of peers) this.trySend(peer, notice('peer-present'))
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    // Legitimate client traffic is exclusively binary (opaque encrypted
    // records). The keepalive text frame never reaches this handler — the
    // runtime auto-responds to it — so any text frame here is a violation.
    if (typeof message === 'string') {
      this.tryClose(ws, CloseCode.ProtocolViolation, 'text frames are not relayed')
      return
    }
    if (message.byteLength > MAX_MESSAGE_BYTES) {
      this.tryClose(ws, CloseCode.MessageTooLarge, 'frame exceeds limit')
      return
    }
    const attachment = this.attachmentOf(ws)
    if (!attachment) return
    // Forward verbatim. If no peer is connected the frame is dropped — presence
    // notices tell the sender when the peer is actually there, and the
    // end-to-end protocol's acks own delivery guarantees.
    for (const peer of this.livePeers(attachment.role)) this.trySend(peer, message)
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.reportPeerGone(ws)
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    this.reportPeerGone(ws)
  }

  /** Tell the counterpart its peer left — unless this socket was merely
   * replaced, or a newer socket for the same role is already live. */
  private reportPeerGone(ws: WebSocket): void {
    const attachment = this.attachmentOf(ws)
    if (!attachment || attachment.replaced) return
    const successors = this.ctx
      .getWebSockets(attachment.role)
      .filter((socket) => socket !== ws && socket.readyState === WS_OPEN)
    if (successors.length > 0) return
    for (const peer of this.livePeers(attachment.role)) this.trySend(peer, notice('peer-gone'))
  }

  private livePeers(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(peerOf(role)).filter((socket) => socket.readyState === WS_OPEN)
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  private trySend(ws: WebSocket, data: ArrayBuffer | string): void {
    try {
      ws.send(data)
    } catch {
      // Peer vanished mid-send; the close/error handlers own the cleanup.
    }
  }

  private tryClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason)
    } catch {
      // Already closing/closed — nothing to do.
    }
  }
}
