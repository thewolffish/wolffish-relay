import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NOTIFY_TITLE_MAX,
  decodeControlRecord,
  encodeControlRecord,
  type NotifyFrame
} from '../src/protocol'
import type { Tunnel } from '../src/tunnel'
import { connect, expectBinary, until, type Client } from './helpers'

/**
 * Push control-plane suite. Every test drives the relay exactly as the real
 * clients do — binary CONTROL records over the tunnel websocket — and the
 * Expo API is mocked by stubbing global fetch, which reaches the Durable
 * Object because tests share its isolate.
 *
 * The ack-timeout tests rely on NOTIFY_ACK_TIMEOUT_MS=150 injected by
 * vitest.config.ts.
 */

/** Distinct from relay.test.ts's zero-padded rid range. */
let ridCounter = 0
function freshRid(): string {
  ridCounter += 1
  return 'f'.repeat(48) + ridCounter.toString(16).padStart(16, '0')
}

const PHONE_ID = 'phone-1234567890abcdef'
const TOKEN = 'ExponentPushToken[test-token-abc123]'

/** Crockford base32, as ULIDs use (no I, L, O, U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let ulidCounter = 0
function freshUlid(): string {
  ulidCounter += 1
  let suffix = ''
  let n = ulidCounter
  while (suffix.length < 6) {
    suffix = ULID_ALPHABET[n % 32] + suffix
    n = Math.floor(n / 32)
  }
  return '01ARZ3NDEKTSV4RRFFQ6' + suffix
}

// ------------------------------------------------------------- expo mock

type ExpoCall = { url: string; authorization: string | null; body: unknown }
const expoCalls: ExpoCall[] = []
let expoRespond: (url: string, body: unknown) => unknown

function defaultExpoResponder(url: string, body: unknown): unknown {
  if (url.endsWith('/push/send')) {
    const messages = body as unknown[]
    return { data: messages.map((_, i) => ({ status: 'ok', id: `tkt-${i + 1}` })) }
  }
  if (url.endsWith('/push/getReceipts')) {
    const ids = (body as { ids: string[] }).ids
    return { data: Object.fromEntries(ids.map((id) => [id, { status: 'ok' }])) }
  }
  throw new Error(`no responder for ${url}`)
}

beforeAll(() => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.startsWith('https://exp.host/')) {
      throw new Error(`unexpected outbound fetch in test: ${url}`)
    }
    const headers = new Headers(init?.headers)
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null
    expoCalls.push({ url, authorization: headers.get('authorization'), body })
    return new Response(JSON.stringify(expoRespond(url, body)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  expoCalls.length = 0
  expoRespond = defaultExpoResponder
})

// --------------------------------------------------------------- helpers

function sendControl(client: Client, frame: Record<string, unknown>): void {
  client.ws.send(encodeControlRecord(frame))
}

async function nextControl(client: Client): Promise<Record<string, unknown>> {
  const record = await expectBinary(await client.next())
  const decoded = decodeControlRecord(record)
  expect(decoded).not.toBeNull()
  return decoded as Record<string, unknown>
}

/** Host + guest connected on a fresh rid, presence notices consumed. */
async function pairUp(rid: string): Promise<{ host: Client; guest: Client }> {
  const host = await connect(rid, 'host')
  const guest = await connect(rid, 'guest')
  expect(await host.next()).toBe('{"t":"peer-present"}')
  expect(await guest.next()).toBe('{"t":"peer-present"}')
  return { host, guest }
}

function stubFor(rid: string): DurableObjectStub {
  return env.TUNNEL.get(env.TUNNEL.idFromName(rid))
}

/**
 * runInDurableObject's generics want an RPC-branded DO class; Tunnel is a
 * legacy-interface DO, so the casts below keep the callback typed without
 * pretending the brand exists.
 */
function runInTunnel<R>(
  rid: string,
  callback: (instance: Tunnel, state: DurableObjectState) => R | Promise<R>
): Promise<R> {
  return runInDurableObject(stubFor(rid) as never, callback as never) as Promise<R>
}

async function readStorage<T>(rid: string, key: string): Promise<T | undefined> {
  return runInTunnel(rid, (_instance, state) => state.storage.get<T>(key))
}

/** Register the phone and wait until the device record is durably there —
 *  register and notify ride different sockets, so ordering must be forced. */
async function registerPhone(
  rid: string,
  guest: Client,
  token: string | null,
  phoneId = PHONE_ID
): Promise<void> {
  sendControl(guest, {
    v: 1,
    type: 'register_push',
    phoneId,
    expoPushToken: token,
    platform: 'ios',
    appVersion: '1.0.17'
  })
  await until(
    async () => (await readStorage(rid, `device:${phoneId}`)) !== undefined,
    2000,
    'device registration'
  )
}

function notifyFrame(overrides: Partial<NotifyFrame> = {}): Record<string, unknown> {
  return {
    v: 1,
    type: 'notify',
    notificationId: freshUlid(),
    phoneId: PHONE_ID,
    runId: 'turn_123_abc',
    phase: 'completed',
    title: 'Run finished',
    body: 'Your migration completed without errors.',
    urgency: 'normal',
    deeplink: null,
    ttl: 3600,
    ts: Date.now(),
    ...overrides
  }
}

// ----------------------------------------------------------------- tests

describe('push registration', () => {
  it('accepts register_push only from the phone (guest) socket', async () => {
    const rid = freshRid()
    const { host } = await pairUp(rid)

    // The desktop socket tries to register a device — silently refused.
    sendControl(host, {
      v: 1,
      type: 'register_push',
      phoneId: PHONE_ID,
      expoPushToken: TOKEN,
      platform: 'ios'
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await readStorage(rid, `device:${PHONE_ID}`)).toBeUndefined()

    // …so a notify for that phoneId has nothing to route to.
    sendControl(host, notifyFrame())
    const result = await nextControl(host)
    expect(result.type).toBe('notify_result')
    expect(result.route).toBe('dropped')
    expect(String(result.reason)).toContain('not registered')
  })

  it('stores a null token (permission denied) as a valid registration', async () => {
    const rid = freshRid()
    const { guest } = await pairUp(rid)
    await registerPhone(rid, guest, null)
    const device = await readStorage<{ expoPushToken: string | null }>(rid, `device:${PHONE_ID}`)
    expect(device).toBeDefined()
    expect(device?.expoPushToken).toBeNull()
  })

  it('refuses to re-bind a socket to a different phoneId', async () => {
    const rid = freshRid()
    const { guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)
    sendControl(guest, {
      v: 1,
      type: 'register_push',
      phoneId: 'phone-other-9999999',
      expoPushToken: TOKEN,
      platform: 'ios'
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await readStorage(rid, 'device:phone-other-9999999')).toBeUndefined()
  })
})

describe('notify validation and authorization', () => {
  it('ignores notify from the phone socket', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)

    sendControl(guest, notifyFrame())
    // No result to the sender, no notification to anyone, no push.
    expect(await guest.silentFor(200)).toBe(true)
    expect(await host.silentFor(0)).toBe(true)
    expect(expoCalls.length).toBe(0)
  })

  it('rejects oversized and malformed frames instead of truncating', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, null)

    const cases: [Record<string, unknown>, string][] = [
      [notifyFrame({ title: 'x'.repeat(NOTIFY_TITLE_MAX + 1) }), 'title'],
      [notifyFrame({ body: 'x'.repeat(200) }), 'body'],
      [notifyFrame({ phase: 'exploded' as NotifyFrame['phase'] }), 'phase'],
      [notifyFrame({ urgency: 'now' as NotifyFrame['urgency'] }), 'urgency'],
      [notifyFrame({ deeplink: 'https://evil.example/x' }), 'deeplink'],
      [{ ...notifyFrame(), notificationId: 'not-a-ulid' }, 'notificationId']
    ]
    for (const [frame, expectedWord] of cases) {
      sendControl(host, frame)
      const result = await nextControl(host)
      expect(result.route).toBe('dropped')
      expect(String(result.reason).toLowerCase()).toContain(expectedWord.toLowerCase())
    }
    // An unknown wire version is dropped before its shape can be trusted at
    // all — not even a result frame comes back.
    sendControl(host, { ...notifyFrame(), v: 2 })
    expect(await host.silentFor(200)).toBe(true)
    // Nothing was delivered for any of them.
    expect(await guest.silentFor(0)).toBe(true)
  })

  it('never forwards control records to the peer', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)

    // A valid registration is terminated at the relay…
    sendControl(guest, { v: 1, type: 'register_push', phoneId: PHONE_ID, platform: 'android' })
    // …an unknown control type is ignored for forward compatibility…
    sendControl(host, { v: 1, type: 'from_the_future', anything: true })
    // …and an undecodable control record is dropped without closing.
    host.ws.send(new Uint8Array([0x03, 0xff, 0x00, 0x41]))

    expect(await host.silentFor(200)).toBe(true)
    expect(await guest.silentFor(0)).toBe(true)
    // The sockets are still healthy — data-plane frames still relay.
    host.ws.send(new Uint8Array([0x02, 7, 7]))
    expect(await expectBinary(await guest.next())).toEqual(new Uint8Array([0x02, 7, 7]))
  })
})

describe('in-band delivery', () => {
  it('delivers to a connected phone, reports inband, and clamps ttl', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, null)

    const frame = notifyFrame({ ttl: 5, urgency: 'high', deeplink: 'wolffish://runs/42' })
    sendControl(host, frame)

    const result = await nextControl(host)
    expect(result).toMatchObject({
      type: 'notify_result',
      notificationId: frame.notificationId,
      route: 'inband'
    })

    const notification = await nextControl(guest)
    expect(notification).toMatchObject({
      v: 1,
      type: 'notification',
      notificationId: frame.notificationId,
      phoneId: PHONE_ID,
      runId: frame.runId,
      phase: 'completed',
      title: frame.title,
      body: frame.body,
      urgency: 'high',
      deeplink: 'wolffish://runs/42',
      ttl: 60 // clamped up from 5 into [60, 86400]
    })

    sendControl(guest, { v: 1, type: 'notification_ack', notificationId: frame.notificationId })
    // Acked in time, and no token anyway: Expo is never touched.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(expoCalls.length).toBe(0)
  })

  it('is idempotent by notificationId', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, null)

    const frame = notifyFrame()
    sendControl(host, frame)
    const first = await nextControl(host)
    const notification = await nextControl(guest)
    sendControl(guest, { v: 1, type: 'notification_ack', notificationId: frame.notificationId })
    expect(notification.notificationId).toBe(frame.notificationId)

    // The exact same frame again: same answer, no second delivery.
    sendControl(host, frame)
    const second = await nextControl(host)
    expect(second).toEqual(first)
    expect(await guest.silentFor(200)).toBe(true)
  })

  it('does not push when the phone acks in time', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)

    const frame = notifyFrame()
    sendControl(host, frame)
    expect((await nextControl(host)).route).toBe('inband')
    const notification = await nextControl(guest)
    sendControl(guest, {
      v: 1,
      type: 'notification_ack',
      notificationId: notification.notificationId
    })

    // Well past the 150ms test ack window: the ack must have prevented Expo.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(expoCalls.length).toBe(0)
  })

  it('falls back to Expo push when the ack never comes', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)

    const frame = notifyFrame({ urgency: 'high', deeplink: 'wolffish://runs/9' })
    sendControl(host, frame)
    expect((await nextControl(host)).route).toBe('inband')
    await nextControl(guest) // delivered — but the phone never acks

    await until(() => expoCalls.length === 1, 3000, 'expo fallback send')
    const call = expoCalls[0]
    expect(call.url).toBe('https://exp.host/--/api/v2/push/send')
    expect(call.authorization).toBe(`Bearer ${env.EXPO_ACCESS_TOKEN}`)
    const messages = call.body as Record<string, unknown>[]
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      to: TOKEN,
      title: frame.title,
      body: frame.body,
      sound: 'default',
      priority: 'high',
      ttl: 3600,
      channelId: 'agent-runs',
      data: {
        notificationId: frame.notificationId,
        runId: frame.runId,
        phase: 'completed',
        url: 'wolffish://runs/9'
      }
    })

    // The ticket is persisted for the receipt sweep.
    await until(
      async () => (await readStorage(rid, `ticket:${frame.notificationId}`)) !== undefined,
      2000,
      'ticket persisted'
    )
    const ticket = await readStorage<{ ticketId: string; phoneId: string }>(
      rid,
      `ticket:${frame.notificationId}`
    )
    expect(ticket).toMatchObject({ ticketId: 'tkt-1', phoneId: PHONE_ID })
  })
})

describe('push fallback with no live phone', () => {
  async function withOfflinePhone(token: string | null): Promise<{ rid: string; host: Client }> {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, token)
    guest.ws.close(1000, 'backgrounded')
    expect(await host.next()).toBe('{"t":"peer-gone"}')
    return { rid, host }
  }

  it('routes straight to Expo push and answers the desktop immediately', async () => {
    const { rid, host } = await withOfflinePhone(TOKEN)
    const frame = notifyFrame()
    sendControl(host, frame)
    const result = await nextControl(host)
    expect(result.route).toBe('push')

    await until(() => expoCalls.length === 1, 3000, 'expo send')
    await until(
      async () => (await readStorage(rid, `ticket:${frame.notificationId}`)) !== undefined,
      2000,
      'ticket persisted'
    )
  })

  it('drops honestly when there is no push token', async () => {
    const { host } = await withOfflinePhone(null)
    sendControl(host, notifyFrame())
    const result = await nextControl(host)
    expect(result.route).toBe('dropped')
    expect(String(result.reason)).toContain('no push token')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(expoCalls.length).toBe(0)
  })
})

describe('receipt sweep', () => {
  /** Push once, then age the stored ticket so the sweep sees it as due. */
  async function agedTicket(rid: string, host: Client): Promise<string> {
    const frame = notifyFrame()
    sendControl(host, frame)
    expect((await nextControl(host)).route).toBe('push')
    const key = `ticket:${frame.notificationId}`
    await until(async () => (await readStorage(rid, key)) !== undefined, 3000, 'ticket persisted')
    await runInTunnel(rid, async (_instance, state) => {
      const ticket = await state.storage.get<{ sentAt: number }>(key)
      await state.storage.put(key, { ...ticket, sentAt: Date.now() - 16 * 60_000 })
    })
    return key
  }

  it('deletes the device registration on a DeviceNotRegistered receipt', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)
    guest.ws.close(1000, 'gone')
    expect(await host.next()).toBe('{"t":"peer-gone"}')

    const ticketKey = await agedTicket(rid, host)
    expoRespond = (url, body) => {
      if (url.endsWith('/push/getReceipts')) {
        const ids = (body as { ids: string[] }).ids
        return {
          data: Object.fromEntries(
            ids.map((id) => [
              id,
              {
                status: 'error',
                message: 'device gone',
                details: { error: 'DeviceNotRegistered' }
              }
            ])
          )
        }
      }
      return defaultExpoResponder(url, body)
    }

    expect(await runDurableObjectAlarm(stubFor(rid))).toBe(true)
    expect(await readStorage(rid, ticketKey)).toBeUndefined()
    expect(await readStorage(rid, `device:${PHONE_ID}`)).toBeUndefined()

    // With the registration pruned, the next notify is honest about it.
    sendControl(host, notifyFrame())
    const result = await nextControl(host)
    expect(result.route).toBe('dropped')
    expect(String(result.reason)).toContain('not registered')
  })

  it('keeps the device registration on an ok receipt', async () => {
    const rid = freshRid()
    const { host, guest } = await pairUp(rid)
    await registerPhone(rid, guest, TOKEN)
    guest.ws.close(1000, 'gone')
    expect(await host.next()).toBe('{"t":"peer-gone"}')

    const ticketKey = await agedTicket(rid, host)
    expect(await runDurableObjectAlarm(stubFor(rid))).toBe(true)
    expect(await readStorage(rid, ticketKey)).toBeUndefined()
    expect(await readStorage(rid, `device:${PHONE_ID}`)).toBeDefined()
  })
})
