import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { CloseCode, KEEPALIVE, MAX_MESSAGE_BYTES } from '../src/protocol'

const RID_A = 'a'.repeat(64)
const RID_B = 'b'.repeat(64)
/** Each test uses its own rid so tunnels never leak state across tests. */
let ridCounter = 0
function freshRid(): string {
  ridCounter += 1
  return ridCounter.toString(16).padStart(64, '0')
}

interface Client {
  ws: WebSocket
  /** Next queued frame, or a rejection after `timeoutMs` of silence. */
  next: (timeoutMs?: number) => Promise<string | ArrayBuffer>
  /** Resolves with the close event once the socket closes. */
  closed: Promise<{ code: number; reason: string }>
  /** True if no frame arrives within `windowMs`. */
  silentFor: (windowMs: number) => Promise<boolean>
}

async function connect(
  rid: string,
  role: string,
  extraHeaders: Record<string, string> = {}
): Promise<Client> {
  const response = await SELF.fetch(`https://relay.test/t/${rid}?role=${role}`, {
    headers: { Upgrade: 'websocket', ...extraHeaders }
  })
  expect(response.status).toBe(101)
  const ws = response.webSocket
  if (!ws) throw new Error('no websocket on 101 response')
  ws.accept()
  // Standard WebSockets default to Blob delivery for binary frames; the tests
  // (like the real clients) want ArrayBuffers.
  ;(ws as unknown as { binaryType: string }).binaryType = 'arraybuffer'

  const queue: (string | ArrayBuffer)[] = []
  const waiters: ((frame: string | ArrayBuffer) => void)[] = []
  ws.addEventListener('message', (event: MessageEvent) => {
    const frame = event.data as string | ArrayBuffer
    const waiter = waiters.shift()
    if (waiter) waiter(frame)
    else queue.push(frame)
  })

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (event: CloseEvent) =>
      resolve({ code: event.code, reason: event.reason })
    )
  })

  const next = (timeoutMs = 2000): Promise<string | ArrayBuffer> => {
    const queued = queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs)
      waiters.push((frame) => {
        clearTimeout(timer)
        resolve(frame)
      })
    })
  }

  const silentFor = async (windowMs: number): Promise<boolean> => {
    await new Promise((resolve) => setTimeout(resolve, windowMs))
    return queue.length === 0
  }

  return { ws, next, closed, silentFor }
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

async function expectBinary(frame: string | ArrayBuffer): Promise<Uint8Array> {
  expect(typeof frame).not.toBe('string')
  return new Uint8Array(frame as ArrayBuffer)
}

describe('front door', () => {
  it('serves a project pointer at the root', async () => {
    const response = await SELF.fetch('https://relay.test/')
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('wolffish relay')
  })

  it('serves a health probe', async () => {
    const response = await SELF.fetch('https://relay.test/healthz')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('rejects non-GET methods', async () => {
    const response = await SELF.fetch(`https://relay.test/t/${RID_A}?role=host`, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('404s malformed rendezvous ids', async () => {
    for (const rid of [
      'tooshort',
      'A'.repeat(64),
      'g'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65)
    ]) {
      const response = await SELF.fetch(`https://relay.test/t/${rid}?role=host`, {
        headers: { Upgrade: 'websocket' }
      })
      expect(response.status).toBe(404)
    }
  })

  it('rejects missing or unknown roles', async () => {
    for (const suffix of ['', '?role=admin', '?role=HOST']) {
      const response = await SELF.fetch(`https://relay.test/t/${RID_A}${suffix}`, {
        headers: { Upgrade: 'websocket' }
      })
      expect(response.status).toBe(400)
    }
  })

  it('requires a websocket upgrade', async () => {
    const response = await SELF.fetch(`https://relay.test/t/${RID_A}?role=host`)
    expect(response.status).toBe(426)
  })
})

describe('pairing and presence', () => {
  it('tells both sides when the pair is complete, and only then', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    expect(await host.silentFor(150)).toBe(true) // alone: no notice

    const guest = await connect(rid, 'guest')
    expect(await guest.next()).toBe('{"t":"peer-present"}')
    expect(await host.next()).toBe('{"t":"peer-present"}')
  })

  it('notifies the survivor when its peer leaves, and keeps it connected', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await host.next() // peer-present
    await guest.next() // peer-present

    guest.ws.close(1000, 'done')
    expect(await host.next()).toBe('{"t":"peer-gone"}')

    // The host stays parked and a returning guest re-pairs instantly.
    const guestAgain = await connect(rid, 'guest')
    expect(await guestAgain.next()).toBe('{"t":"peer-present"}')
    expect(await host.next()).toBe('{"t":"peer-present"}')
  })
})

describe('relaying', () => {
  it('forwards binary frames verbatim in both directions', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await host.next()
    await guest.next()

    host.ws.send(bytes(1, 2, 3, 255))
    expect(await expectBinary(await guest.next())).toEqual(bytes(1, 2, 3, 255))

    guest.ws.send(bytes(9, 8, 7))
    expect(await expectBinary(await host.next())).toEqual(bytes(9, 8, 7))
  })

  it('keeps tunnels with different rendezvous ids fully isolated', async () => {
    const hostA = await connect(RID_A, 'host')
    const guestA = await connect(RID_A, 'guest')
    const hostB = await connect(RID_B, 'host')
    const guestB = await connect(RID_B, 'guest')
    await Promise.all([hostA.next(), guestA.next(), hostB.next(), guestB.next()])

    hostA.ws.send(bytes(42))
    expect(await expectBinary(await guestA.next())).toEqual(bytes(42))
    expect(await guestB.silentFor(150)).toBe(true)
    expect(await hostB.silentFor(0)).toBe(true)
  })

  it('drops frames sent while the peer is absent', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    host.ws.send(bytes(1))

    const guest = await connect(rid, 'guest')
    await guest.next() // peer-present only
    expect(await guest.silentFor(150)).toBe(true)
  })
})

describe('enforcement', () => {
  it('answers the transport keepalive without closing the socket', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    host.ws.send(KEEPALIVE.request)
    expect(await host.next()).toBe(KEEPALIVE.response)
  })

  it('closes the connection on any other text frame', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    host.ws.send('{"sneaky":"json"}')
    const closeEvent = await host.closed
    expect(closeEvent.code).toBe(CloseCode.ProtocolViolation)
  })

  it('does not relay the violating text frame to the peer', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await host.next()
    await guest.next()

    host.ws.send('malicious text')
    await host.closed
    // Guest hears the host left (its socket died) — but never the text itself.
    expect(await guest.next()).toBe('{"t":"peer-gone"}')
    expect(await guest.silentFor(150)).toBe(true)
  })

  it('closes the connection on oversized frames', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    host.ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1))
    const closeEvent = await host.closed
    expect(closeEvent.code).toBe(CloseCode.MessageTooLarge)
  })

  it('accepts frames at exactly the limit', async () => {
    const rid = freshRid()
    const host = await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await host.next()
    await guest.next()

    host.ws.send(new Uint8Array(MAX_MESSAGE_BYTES))
    const received = await expectBinary(await guest.next(5000))
    expect(received.byteLength).toBe(MAX_MESSAGE_BYTES)
  })
})

describe('reconnection', () => {
  it('evicts the previous socket when the same role reconnects', async () => {
    const rid = freshRid()
    const hostOld = await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await hostOld.next()
    await guest.next()

    const hostNew = await connect(rid, 'host')
    const closeEvent = await hostOld.closed
    expect(closeEvent.code).toBe(CloseCode.Replaced)

    // The guest never saw its peer disappear — the replacement is seamless…
    expect(await hostNew.next()).toBe('{"t":"peer-present"}')
    const guestNotice = await guest.next()
    expect(guestNotice).toBe('{"t":"peer-present"}')

    // …and traffic flows over the new socket immediately, in both directions.
    guest.ws.send(bytes(5, 5))
    expect(await expectBinary(await hostNew.next())).toEqual(bytes(5, 5))
    hostNew.ws.send(bytes(6))
    expect(await expectBinary(await guest.next())).toEqual(bytes(6))
  })

  it('never delivers peer-gone to a guest during a host replacement', async () => {
    const rid = freshRid()
    await connect(rid, 'host')
    const guest = await connect(rid, 'guest')
    await guest.next()

    await connect(rid, 'host')
    const notice = await guest.next()
    expect(notice).not.toBe('{"t":"peer-gone"}')
  })
})
