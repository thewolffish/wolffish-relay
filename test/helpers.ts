import { SELF } from 'cloudflare:test'
import { expect } from 'vitest'

/**
 * WebSocket test client against the worker under test, with a pull-based
 * frame queue so assertions read like the protocol they verify.
 */
export interface Client {
  ws: WebSocket
  /** Next queued frame, or a rejection after `timeoutMs` of silence. */
  next: (timeoutMs?: number) => Promise<string | ArrayBuffer>
  /** Resolves with the close event once the socket closes. */
  closed: Promise<{ code: number; reason: string }>
  /** True if no frame arrives within `windowMs`. */
  silentFor: (windowMs: number) => Promise<boolean>
}

export async function connect(
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

export function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

export async function expectBinary(frame: string | ArrayBuffer): Promise<Uint8Array> {
  expect(typeof frame).not.toBe('string')
  return new Uint8Array(frame as ArrayBuffer)
}

/** Poll `check` until it holds, or fail after `timeoutMs`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  label = 'condition'
): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label} not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
