import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { version } from '../package.json'
import { CloseCode, KEEPALIVE, MAX_MESSAGE_BYTES } from '../src/protocol'
import { bytes, connect, expectBinary } from './helpers'

const RID_A = 'a'.repeat(64)
const RID_B = 'b'.repeat(64)
/** Each test uses its own rid so tunnels never leak state across tests.
 *  (push.test.ts uses an f-prefixed range — these can never collide.) */
let ridCounter = 0
function freshRid(): string {
  ridCounter += 1
  return ridCounter.toString(16).padStart(64, '0')
}

describe('front door', () => {
  it('serves the landing page at the root', async () => {
    const response = await SELF.fetch('https://relay.test/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    const body = await response.text()
    expect(body).toContain('wolffish')
    expect(body).toContain(`v${version}`)
    expect(body).toContain('github.com/thewolffish/wolffish-relay')
    expect(body).toContain('og:image')
    expect(body).toContain('https://cdn.wolffi.sh/generic/banner.jpg')
    expect(body).toContain('summary_large_image')
    expect(body).not.toContain('<script')
  })

  it('the landing page explains what the relay can and cannot do', async () => {
    const body = await (await SELF.fetch('https://relay.test/')).text()
    // How it works
    for (const beat of ['Meet.', 'Move.', 'Forget.']) expect(body).toContain(beat)
    // Capabilities and their honest limits
    for (const claim of ['Cannot read', 'Cannot forge', 'Cannot alter', 'Cannot replay', 'Can see'])
      expect(body).toContain(claim)
    // Retention — the promise a visitor most wants to check
    expect(body).toContain('What is stored here')
    expect(body).toContain('Message history')
    expect(body).toContain('0 B')
    // A way to go deeper
    expect(body).toContain('https://cdn.wolffi.sh/generic/relay.html')
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

  it('answers HEAD for uptime checks', async () => {
    const health = await SELF.fetch('https://relay.test/healthz', { method: 'HEAD' })
    expect(health.status).toBe(200)
    const page = await SELF.fetch('https://relay.test/', { method: 'HEAD' })
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
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
