import {
  ANDROID_CHANNEL_ID,
  CONTROL_RECORD,
  CloseCode,
  KEEPALIVE,
  MAX_MESSAGE_BYTES,
  NOTIFY_ACK_TIMEOUT_MS,
  NOTIFY_DEDUP_RETENTION_MS,
  RECEIPT_SWEEP_DELAY_MS,
  WS_OPEN,
  decodeControlRecord,
  encodeControlRecord,
  isRole,
  notice,
  parseNotificationAck,
  parseNotify,
  parseRegisterPush,
  peerOf,
  tokenPrefix,
  type NotificationFrame,
  type NotifyFrame,
  type NotifyResultFrame,
  type PushPlatform,
  type Role
} from './protocol'
import { getExpoReceipts, sendExpoPush } from './push'
import type { Env } from './types'

/**
 * Data attached to each socket. Connection state lives inside the WebSocket
 * itself (surviving hibernation there) — never in instance fields.
 */
interface Attachment {
  role: Role
  /** Set on a socket just before it is evicted by a newer connection for the
   * same role, so its close handler knows not to report the peer as gone. */
  replaced?: true
  /** Stable device id the phone registered on this socket. Bound on the first
   * register_push and immutable for the socket's lifetime — later frames on
   * the same socket cannot re-identify as a different device. */
  phoneId?: string
}

/** Push registration for one phone. Key: `device:<phoneId>`. */
interface DeviceRecord {
  /** Null when notification permission was denied — in-band delivery only. */
  expoPushToken: string | null
  platform: PushPlatform
  appVersion: string | null
  updatedAt: number
}

/** An Expo ticket awaiting its receipt. Key: `ticket:<notificationId>`. */
interface TicketRecord {
  ticketId: string
  phoneId: string
  sentAt: number
}

/** Idempotency memory for a processed notify. Key: `notif:<notificationId>`. */
interface ResultRecord {
  result: NotifyResultFrame
  at: number
}

const DEVICE_PREFIX = 'device:'
const TICKET_PREFIX = 'ticket:'
const RESULT_PREFIX = 'notif:'

/** A ticket whose receipt never materialized is abandoned after this long —
 *  Expo only keeps receipts for about a day, so retrying past that is noise. */
const TICKET_RETENTION_MS = NOTIFY_DEDUP_RETENTION_MS

/** Floor between alarm firings, so a failing receipt fetch can never turn the
 *  sweep into a tight loop. */
const MIN_ALARM_GAP_MS = 60_000

/**
 * One Tunnel instance exists per rendezvous ID (Durable Objects guarantee a
 * single global instance per name). It holds at most two live sockets — one
 * `host`, one `guest` — and forwards binary frames verbatim between them.
 *
 * DO identity: the object is addressed by `idFromName(rid)` where
 * `rid = HMAC(pairing_secret, "rid-v1")` — a STABLE per-pairing identifier,
 * not a per-session one. Both devices re-derive the same rid from the stored
 * pairing secret on every reconnect, so push registrations stored here
 * survive reconnects for the life of the pairing. Re-pairing mints a new
 * secret (hence a new rid and a fresh DO), and the phone re-registers its
 * push token immediately after pairing, so registrations follow the pairing.
 *
 * Retention, stated precisely:
 * - The DATA PLANE is untouched: handshake (0x01) and transport (0x02)
 *   records are forwarded verbatim, never parsed, stored, or logged.
 * - The push CONTROL PLANE (0x03 records, defined in protocol.ts) is
 *   deliberately relay-terminated. It persists exactly three small record
 *   kinds in DO storage: device push registrations keyed by phoneId, Expo
 *   ticket ids awaiting receipts, and processed notificationIds for
 *   idempotency (pruned after 24 h). Notification titles/bodies pass through
 *   to Expo when (and only when) push fallback fires; they are never stored
 *   and never logged. Push tokens are logged as a short prefix only.
 * - Uses the WebSocket Hibernation API; per-socket state rides in the
 *   connection attachment and everything else lives in DO storage, so an
 *   idle tunnel is still evicted from memory entirely.
 */
export class Tunnel implements DurableObject {
  private readonly ctx: DurableObjectState
  private readonly env: Env

  /**
   * In-band deliveries whose phone ack is still outstanding. Instance state
   * is acceptable here and only here: the entry lives for the ~2 s ack
   * window, during which the pending timer keeps the object in memory. If
   * the object is torn down mid-window anyway (deploy, crash), the fallback
   * for that one notification is lost — the phone-side dedupe makes the
   * cheap fix (also pushing) worse than the miss.
   */
  private readonly pendingAcks = new Map<string, true>()

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
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
      const previous = this.attachmentOf(stale)
      stale.serializeAttachment({ ...previous, role, replaced: true } satisfies Attachment)
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

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    // Legitimate client traffic is exclusively binary (opaque encrypted
    // records, plus the control records handled below). The keepalive text
    // frame never reaches this handler — the runtime auto-responds to it —
    // so any text frame here is a violation.
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

    const record = new Uint8Array(message)
    // Control records are addressed to the relay — terminated here, never
    // forwarded. Everything else stays opaque: nothing past byte 0 is read.
    if (record.length > 0 && record[0] === CONTROL_RECORD) {
      await this.handleControl(ws, attachment, record)
      return
    }

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

  // ---------------------------------------------------------- control plane

  private async handleControl(
    ws: WebSocket,
    attachment: Attachment,
    record: Uint8Array
  ): Promise<void> {
    const raw = decodeControlRecord(record)
    if (!raw || raw.v !== 1 || typeof raw.type !== 'string') {
      console.warn('[push] undecodable control record dropped')
      return
    }
    switch (raw.type) {
      case 'register_push':
        return this.onRegisterPush(ws, attachment, raw)
      case 'notify':
        return this.onNotify(ws, attachment, raw)
      case 'notification_ack':
        return this.onNotificationAck(attachment, raw)
      default:
        // Forward compatibility: a newer client may speak control types this
        // relay predates. Ignoring them is the contract.
        console.warn(`[push] unknown control type "${raw.type}" ignored`)
    }
  }

  /**
   * The phone registers (or clears) its Expo push token. Authorization is the
   * session itself: only the socket that joined this DO's rendezvous as
   * `guest` — which requires the pairing secret the rid derives from — can
   * register, and the first registration binds the socket to one phoneId.
   */
  private async onRegisterPush(
    ws: WebSocket,
    attachment: Attachment,
    raw: Record<string, unknown>
  ): Promise<void> {
    if (attachment.role !== 'guest') {
      console.warn('[push] register_push from a non-phone socket rejected')
      return
    }
    const parsed = parseRegisterPush(raw)
    if ('error' in parsed) {
      console.warn(`[push] register_push rejected: ${parsed.error}`)
      return
    }
    const frame = parsed.frame
    // Session-bound identity: a socket that already registered as one device
    // cannot re-register as another. (A legitimate phone re-registers the
    // SAME id on foreground/rotation; only a confused or hostile client hits
    // this.)
    if (attachment.phoneId && attachment.phoneId !== frame.phoneId) {
      console.warn('[push] register_push with a different phoneId on a bound socket rejected')
      return
    }
    if (!attachment.phoneId) {
      ws.serializeAttachment({ ...attachment, phoneId: frame.phoneId } satisfies Attachment)
    }
    const record: DeviceRecord = {
      expoPushToken: frame.expoPushToken,
      platform: frame.platform,
      appVersion: frame.appVersion ?? null,
      updatedAt: Date.now()
    }
    await this.ctx.storage.put(`${DEVICE_PREFIX}${frame.phoneId}`, record)
    console.log(
      `[push] device registered: ${frame.phoneId} (${frame.platform}, app ${
        frame.appVersion ?? '?'
      }, token ${tokenPrefix(frame.expoPushToken)})`
    )
  }

  /**
   * The desktop asks for a notification to reach the phone. Routing decision
   * tree, in order:
   *
   *   1. already processed?          -> replay the stored result, send nothing
   *   2. phoneId not registered here -> dropped (error result, no reroute)
   *   3. phone socket live           -> deliver in-band, answer `inband`,
   *      then wait ~2 s for the phone's ack in the background and fall back
   *      to Expo push if it never comes (the phone dedupes by notificationId)
   *   4. no live phone, token known  -> answer `push`, send via Expo in the
   *      background (the desktop is never blocked on Expo's round trip)
   *   5. no live phone, no token     -> dropped
   */
  private async onNotify(
    ws: WebSocket,
    attachment: Attachment,
    raw: Record<string, unknown>
  ): Promise<void> {
    if (attachment.role !== 'host') {
      console.warn('[push] notify from a non-desktop socket rejected')
      return
    }
    const parsed = parseNotify(raw)
    if ('error' in parsed) {
      console.warn(`[push] notify rejected: ${parsed.error}`)
      this.sendControl(ws, {
        v: 1,
        type: 'notify_result',
        notificationId: typeof raw.notificationId === 'string' ? raw.notificationId : null,
        route: 'dropped',
        reason: parsed.error
      })
      return
    }
    const frame = parsed.frame

    // Idempotency: a re-sent notificationId gets its original outcome and
    // triggers nothing.
    const resultKey = `${RESULT_PREFIX}${frame.notificationId}`
    const prior = await this.ctx.storage.get<ResultRecord>(resultKey)
    if (prior) {
      this.sendControl(ws, prior.result)
      return
    }

    // The phoneId must name a device registered ON THIS PAIRING — reject a
    // mismatch rather than rerouting to whatever happens to be registered.
    const device = await this.ctx.storage.get<DeviceRecord>(`${DEVICE_PREFIX}${frame.phoneId}`)
    let result: NotifyResultFrame
    if (!device) {
      console.warn(`[push] notify for unregistered phoneId ${frame.phoneId} dropped`)
      result = {
        v: 1,
        type: 'notify_result',
        notificationId: frame.notificationId,
        route: 'dropped',
        reason: 'phoneId is not registered on this pairing'
      }
    } else {
      const phones = this.socketsOf('guest')
      if (phones.length > 0) {
        const notification: NotificationFrame = { ...frame, type: 'notification' }
        this.pendingAcks.set(frame.notificationId, true)
        for (const phone of phones) this.sendControl(phone, notification)
        this.ctx.waitUntil(this.fallBackUnlessAcked(frame, device))
        result = {
          v: 1,
          type: 'notify_result',
          notificationId: frame.notificationId,
          route: 'inband'
        }
      } else if (device.expoPushToken) {
        // waitUntil, never await: Expo's 1–2 s round trip must not block the
        // desktop's answer (or, via the input gate, the whole tunnel).
        this.ctx.waitUntil(this.pushViaExpo(frame, device.expoPushToken))
        result = {
          v: 1,
          type: 'notify_result',
          notificationId: frame.notificationId,
          route: 'push'
        }
      } else {
        result = {
          v: 1,
          type: 'notify_result',
          notificationId: frame.notificationId,
          route: 'dropped',
          reason: 'phone is offline and has no push token registered'
        }
      }
    }

    await this.ctx.storage.put(resultKey, { result, at: Date.now() } satisfies ResultRecord)
    // Make sure SOMETHING will prune this idempotency record eventually.
    await this.armAlarm(Date.now() + NOTIFY_DEDUP_RETENTION_MS)
    this.sendControl(ws, result)
  }

  private async onNotificationAck(
    attachment: Attachment,
    raw: Record<string, unknown>
  ): Promise<void> {
    if (attachment.role !== 'guest') return
    const parsed = parseNotificationAck(raw)
    if ('error' in parsed) return
    this.pendingAcks.delete(parsed.frame.notificationId)
  }

  /** The in-band ack window: give the phone a moment, then push anyway. */
  private async fallBackUnlessAcked(frame: NotifyFrame, device: DeviceRecord): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.ackTimeoutMs()))
    if (!this.pendingAcks.has(frame.notificationId)) return // acked in time
    this.pendingAcks.delete(frame.notificationId)
    if (!device.expoPushToken) {
      console.warn(
        `[push] ${frame.notificationId}: no ack from the phone and no push token — not delivered`
      )
      return
    }
    console.log(`[push] ${frame.notificationId}: no ack within ${this.ackTimeoutMs()}ms — pushing`)
    await this.pushViaExpo(frame, device.expoPushToken)
  }

  /** Test-only override hatch; production always runs the protocol constant. */
  private ackTimeoutMs(): number {
    const override = Number(this.env.NOTIFY_ACK_TIMEOUT_MS ?? '')
    return Number.isFinite(override) && override > 0 ? override : NOTIFY_ACK_TIMEOUT_MS
  }

  /** Send one notification through Expo and persist its ticket for the sweep. */
  private async pushViaExpo(frame: NotifyFrame, token: string): Promise<void> {
    const [ticket] = await sendExpoPush(this.env, [
      {
        to: token,
        title: frame.title,
        body: frame.body,
        data: {
          notificationId: frame.notificationId,
          runId: frame.runId,
          phase: frame.phase,
          url: frame.deeplink
        },
        sound: 'default',
        priority: frame.urgency === 'high' ? 'high' : 'default',
        ttl: frame.ttl,
        channelId: ANDROID_CHANNEL_ID
      }
    ])
    if (!ticket) return // transport/HTTP failure — already logged by push.ts
    if (ticket.status === 'error') {
      const code = ticket.details?.error ?? 'unknown'
      if (code === 'DeviceNotRegistered') {
        // The token is dead (app uninstalled, token rotated away). Drop the
        // registration so later notifies degrade honestly instead of
        // pretending to push.
        await this.ctx.storage.delete(`${DEVICE_PREFIX}${frame.phoneId}`)
        console.warn(
          `[push] ${frame.notificationId}: DeviceNotRegistered ticket — registration for ` +
            `${frame.phoneId} removed (token ${tokenPrefix(token)})`
        )
      } else if (code === 'MessageTooBig') {
        console.error(`[push] ${frame.notificationId}: MessageTooBig ticket — payload over 4 KiB`)
      } else if (code === 'MessageRateExceeded') {
        console.error(
          `[push] ${frame.notificationId}: MessageRateExceeded ticket — sending too fast for ` +
            `${frame.phoneId}`
        )
      } else if (code === 'InvalidCredentials') {
        console.error(
          `[push] ${frame.notificationId}: InvalidCredentials ticket — the FCM/APNs credentials ` +
            'on the Expo project are broken; no push will deliver until they are fixed'
        )
      } else {
        console.error(
          `[push] ${frame.notificationId}: error ticket ${code}: ${ticket.message ?? ''}`
        )
      }
      return
    }
    await this.ctx.storage.put(`${TICKET_PREFIX}${frame.notificationId}`, {
      ticketId: ticket.id,
      phoneId: frame.phoneId,
      sentAt: Date.now()
    } satisfies TicketRecord)
    // Receipts are what actually prove delivery (tickets only prove Expo took
    // the message) — sweep them after Expo's recommended 15 minutes.
    await this.armAlarm(Date.now() + RECEIPT_SWEEP_DELAY_MS)
  }

  /**
   * Receipt sweep + storage hygiene. Fires RECEIPT_SWEEP_DELAY_MS after a
   * push send (and NOTIFY_DEDUP_RETENTION_MS after a notify, for pruning).
   *
   * A DeviceNotRegistered receipt deletes the device registration — that is
   * the only reliable signal a token is dead. An InvalidCredentials receipt
   * is logged loudly and distinctly: tickets alone always look successful,
   * so this is the only place broken FCM/APNs credentials ever surface.
   */
  async alarm(): Promise<void> {
    const now = Date.now()

    const tickets = await this.ctx.storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
    const due: [string, TicketRecord][] = []
    for (const [key, ticket] of tickets) {
      if (ticket.sentAt + RECEIPT_SWEEP_DELAY_MS <= now) due.push([key, ticket])
    }

    if (due.length > 0) {
      const receipts = await getExpoReceipts(
        this.env,
        due.map(([, ticket]) => ticket.ticketId)
      )
      if (receipts) {
        for (const [key, ticket] of due) {
          const receipt = receipts[ticket.ticketId]
          if (!receipt) {
            console.warn(`[push] no receipt for ticket ${ticket.ticketId} — dropped from sweep`)
          } else if (receipt.status === 'error') {
            const code = receipt.details?.error ?? 'unknown'
            if (code === 'DeviceNotRegistered') {
              await this.ctx.storage.delete(`${DEVICE_PREFIX}${ticket.phoneId}`)
              console.warn(
                `[push] receipt says DeviceNotRegistered — registration for ${ticket.phoneId} removed`
              )
            } else if (code === 'InvalidCredentials') {
              console.error(
                '[push] receipt says InvalidCredentials — the FCM/APNs credentials on the Expo ' +
                  'project are broken and every push is silently failing; fix the Expo credentials'
              )
            } else if (code === 'MessageRateExceeded') {
              console.error(`[push] receipt says MessageRateExceeded for ${ticket.phoneId}`)
            } else {
              console.error(`[push] error receipt ${code}: ${receipt.message ?? ''}`)
            }
          }
          await this.ctx.storage.delete(key)
        }
      } else {
        // Receipt endpoint unreachable: keep the due tickets for the next
        // sweep, but never forever — Expo forgets receipts after ~a day.
        for (const [key, ticket] of due) {
          if (ticket.sentAt + TICKET_RETENTION_MS <= now) {
            console.warn(
              `[push] ticket ${ticket.ticketId} abandoned — receipts unreachable for 24h`
            )
            await this.ctx.storage.delete(key)
          }
        }
      }
    }

    // Prune idempotency records past their retention.
    const results = await this.ctx.storage.list<ResultRecord>({ prefix: RESULT_PREFIX })
    for (const [key, record] of results) {
      if (record.at + NOTIFY_DEDUP_RETENTION_MS <= now) await this.ctx.storage.delete(key)
    }

    // Re-arm for whatever remains, with a floor so failures can't tight-loop.
    let next: number | null = null
    const remainingTickets = await this.ctx.storage.list<TicketRecord>({ prefix: TICKET_PREFIX })
    for (const [, ticket] of remainingTickets) {
      const at = ticket.sentAt + RECEIPT_SWEEP_DELAY_MS
      next = next === null ? at : Math.min(next, at)
    }
    const remainingResults = await this.ctx.storage.list<ResultRecord>({ prefix: RESULT_PREFIX })
    for (const [, record] of remainingResults) {
      const at = record.at + NOTIFY_DEDUP_RETENTION_MS
      next = next === null ? at : Math.min(next, at)
    }
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, now + MIN_ALARM_GAP_MS))
  }

  /** Move the single DO alarm earlier if needed; never postpone one. */
  private async armAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }

  private sendControl(ws: WebSocket, frame: Record<string, unknown>): void {
    this.trySend(ws, encodeControlRecord(frame))
  }

  // ------------------------------------------------------------- forwarding

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
    return this.socketsOf(peerOf(role))
  }

  private socketsOf(role: Role): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((socket) => socket.readyState === WS_OPEN)
  }

  private attachmentOf(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  private trySend(ws: WebSocket, data: ArrayBuffer | Uint8Array | string): void {
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
