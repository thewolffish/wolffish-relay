/**
 * A tunnel endpoint — the code both simulated devices run. Connects to the
 * relay, performs the Noise handshake, then speaks the encrypted frame
 * protocol: RPC, events, and resumable file transfer.
 *
 * Everything handed to the socket is ciphertext. The relay sees opaque binary
 * frames and nothing else; `wiretap` records exactly those bytes so the run can
 * prove it.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { Initiator, Responder } from './noise.mjs'

export const FrameType = {
  PING: 0x00,
  HELLO: 0x01,
  RPC_REQ: 0x02,
  RPC_RES: 0x03,
  EVENT: 0x04,
  FILE_MANIFEST: 0x10,
  FILE_WANT: 0x11,
  FILE_CHUNK: 0x12,
  FILE_ACK: 0x13,
  FILE_DONE: 0x14
}

/**
 * Outer record type, the first byte of every binary message.
 *
 * Without this, a reconnecting device can mistake a straggler from the previous
 * session for a handshake message: when a phone drops mid-transfer the desktop's
 * socket still holds queued chunks, and those flush to the *new* connection. The
 * marker lets each side ignore records that belong to a session it has already
 * left. It reveals only "handshake" versus "data" — the same metadata a TLS
 * record header exposes — and never anything about content.
 */
export const RecordType = { HANDSHAKE: 0x01, TRANSPORT: 0x02 }

export const CHUNK_SIZE = 256 * 1024 // ciphertext stays far under the relay's 1 MiB cap
export const WINDOW = 32 // chunks in flight before the sender waits for credit
export const ACK_EVERY = 16 // receiver acks (and checkpoints) this often

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class Disconnected extends Error {
  constructor(reason) {
    super(`tunnel disconnected: ${reason}`)
    this.name = 'Disconnected'
  }
}

/** Records the exact bytes crossing the socket, for the ciphertext audit. */
export class Wiretap {
  constructor(limit = 12) {
    this.limit = limit
    this.samples = []
    this.frameCount = 0
    this.byteCount = 0
    /** Byte-value histogram over sampled ciphertext, for the entropy check.
     * Sampling a slice of every frame keeps this cheap on 248 MB transfers
     * while still totalling megabytes — enough for a meaningful measure. */
    this.histogram = new Uint32Array(256)
    this.histogramBytes = 0
  }

  observe(direction, ciphertext, context) {
    this.frameCount += 1
    this.byteCount += ciphertext.length
    const window = ciphertext.subarray(0, Math.min(ciphertext.length, 2048))
    for (const byte of window) this.histogram[byte] += 1
    this.histogramBytes += window.length
    if (this.samples.length < this.limit) {
      this.samples.push({
        direction,
        context,
        bytes: ciphertext.length,
        head: Buffer.from(ciphertext.subarray(0, 48)).toString('hex')
      })
    }
  }

  /** Shannon entropy in bits per byte; 8.0 is indistinguishable from random. */
  entropy() {
    let total = 0
    for (const count of this.histogram) {
      if (!count) continue
      const p = count / this.histogramBytes
      total -= p * Math.log2(p)
    }
    return total
  }
}

export class Tunnel {
  /**
   * @param {object} opts
   * @param {'host'|'guest'} opts.role  desktop parks as host; mobile dials as guest
   */
  constructor({ role, relayUrl, rid, name, log, wiretap, lookup }) {
    this.role = role
    this.relayUrl = relayUrl
    this.rid = rid
    this.name = name
    this.log = log
    this.wiretap = wiretap
    this.lookup = lookup
    this.rpcHandlers = new Map()
    this.eventHandlers = new Map()
    this.pending = new Map()
    this.nextRpcId = 1
    this.peerPresent = false
    this.closed = false
    this.receiving = new Map()
    this.fileWaiters = new Map()
    this.handshakeQueue = []
    this.bytesSent = 0
    this.bytesReceived = 0
  }

  // ---------------------------------------------------------------- transport

  async connect() {
    this.ws = new WebSocket(`${this.relayUrl}/t/${this.rid}?role=${this.role}`, {
      lookup: this.lookup,
      maxPayload: 2 * 1024 * 1024
    })
    this.closed = false
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve)
      this.ws.once('error', reject)
    })
    this.ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
    this.ws.on('close', (code, reason) => {
      this.closed = true
      this.closeInfo = { code, reason: reason.toString() }
      this.#abortInFlight(`code ${code}`)
      this.onClose?.(this.closeInfo)
    })
    // Relay-answered keepalive; never wakes the Durable Object.
    this.keepalive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send('ping')
    }, 25_000)
    this.keepalive.unref?.()
  }

  /** Resolves once the relay reports the other role is connected. */
  waitForPeer(timeoutMs = 15_000) {
    if (this.peerPresent) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('peer never arrived')), timeoutMs)
      this.onPeerPresent = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  #onMessage(data, isBinary) {
    if (!isBinary) {
      const notice = data.toString()
      if (notice === 'pong') return
      if (notice === '{"t":"peer-present"}') {
        this.peerPresent = true
        this.log?.relay(`${this.name}: peer-present`)
        this.onPeerPresent?.()
      } else if (notice === '{"t":"peer-gone"}') {
        this.peerPresent = false
        this.log?.relay(`${this.name}: peer-gone`)
        // Our socket is fine, but anything in flight is now going nowhere: the
        // relay drops frames with no peer to receive them.
        this.#abortInFlight('peer gone')
        this.onPeerGone?.()
      }
      return
    }

    const record = new Uint8Array(data)
    this.bytesReceived += record.length
    const kind = record[0]
    const body = record.subarray(1)

    if (kind === RecordType.TRANSPORT) {
      if (!this.handshakeDone) {
        // A straggler from a session this side has already left.
        this.staleDropped = (this.staleDropped ?? 0) + 1
        return
      }
      let plaintext
      try {
        plaintext = this.receiveCipher.decrypt(body)
      } catch (error) {
        this.log?.wire(`${this.name}: frame failed authentication — ${error.message}`)
        return
      }
      this.#onFrame(plaintext)
      return
    }

    if (kind !== RecordType.HANDSHAKE) return
    if (this.handshakeDone) {
      this.log?.wire(`${this.name}: ignoring handshake record for an established session`)
      return
    }
    // A returning peer can send its first handshake message before this side has
    // started listening; hold it rather than dropping it.
    if (this.handshakeInbox) this.handshakeInbox(body)
    else this.handshakeQueue.push(body)
  }

  /** Fail every outstanding promise so callers learn immediately instead of
   * waiting out a timeout. */
  #abortInFlight(reason) {
    for (const { reject } of this.pending.values()) reject(new Disconnected(reason))
    this.pending.clear()
    for (const reject of this.fileDoneRejects?.values() ?? []) reject(new Disconnected(reason))
    this.fileDoneRejects?.clear()
    this.fileWaiters.clear()
    for (const state of this.sending?.values() ?? []) state.onCredit?.()

    // An interrupted receive is abandoned mid-file while still holding an open
    // file handle. Close it explicitly — leaving it to the garbage collector is
    // deprecated in Node, and the resumed transfer reopens from the on-disk
    // checkpoint rather than from anything held here.
    for (const state of this.receiving.values()) state.handle.close().catch(() => {})
    this.receiving.clear()
  }

  /** Forget the session keys so a returning peer can hand-shake afresh over the
   * same parked socket. */
  resetSession() {
    this.handshakeDone = false
    this.sendCipher = null
    this.receiveCipher = null
    this.handshakeQueue = []
    this.handshakeInbox = null
  }

  #sendCiphertext(ciphertext, context, kind = RecordType.TRANSPORT) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN)
      throw new Disconnected('socket closed')
    const record = new Uint8Array(1 + ciphertext.length)
    record[0] = kind
    record.set(ciphertext, 1)
    this.wiretap?.observe(`${this.role}→relay`, record, context)
    this.bytesSent += record.length
    this.ws.send(record)
  }

  sendFrame(type, payload) {
    const body =
      payload instanceof Uint8Array ? payload : encoder.encode(JSON.stringify(payload ?? {}))
    const frame = new Uint8Array(1 + body.length)
    frame[0] = type
    frame.set(body, 1)
    this.#sendCiphertext(this.sendCipher.encrypt(frame), frameName(type))
  }

  // ---------------------------------------------------------------- handshake

  /** Mobile side: initiate IKpsk2 using what the QR carried. */
  async handshakeAsInitiator({ staticKeypair, remoteStaticPublicKey, psk, payload }) {
    const initiator = new Initiator({ staticKeypair, remoteStaticPublicKey, psk })
    const message1 = initiator.writeMessage1(encoder.encode(JSON.stringify(payload ?? {})))
    const reply = this.#expectHandshakeMessage()
    this.#sendCiphertext(message1, 'noise msg1', RecordType.HANDSHAKE)
    const message2 = await reply
    const result = initiator.readMessage2(message2)
    this.sendCipher = result.send
    this.receiveCipher = result.receive
    this.handshakeDone = true
    this.handshakeHash = Buffer.from(result.handshakeHash).toString('hex')
    return JSON.parse(decoder.decode(result.payload) || '{}')
  }

  /** Desktop side: respond, learning and pinning the mobile's static key. */
  async handshakeAsResponder({ staticKeypair, psk, payload, expectedPeerKey }) {
    const responder = new Responder({ staticKeypair, psk })
    const message1 = await this.#expectHandshakeMessage(20_000)
    const incoming = responder.readMessage1(message1)
    const peerKey = Buffer.from(incoming.remoteStaticPublicKey).toString('hex')
    if (expectedPeerKey && expectedPeerKey !== peerKey) throw new Error('peer key mismatch')
    const out = responder.writeMessage2(encoder.encode(JSON.stringify(payload ?? {})))
    this.#sendCiphertext(out.message, 'noise msg2', RecordType.HANDSHAKE)
    this.sendCipher = out.send
    this.receiveCipher = out.receive
    this.handshakeDone = true
    this.handshakeHash = Buffer.from(out.handshakeHash).toString('hex')
    return {
      peerStaticKey: peerKey,
      payload: JSON.parse(decoder.decode(incoming.payload) || '{}')
    }
  }

  #expectHandshakeMessage(timeoutMs = 15_000) {
    const queued = this.handshakeQueue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('handshake timed out')), timeoutMs)
      this.handshakeInbox = (message) => {
        clearTimeout(timer)
        this.handshakeInbox = null
        resolve(message)
      }
    })
  }

  // --------------------------------------------------------------- rpc/events

  onRpc(method, handler) {
    this.rpcHandlers.set(method, handler)
  }

  onEvent(topic, handler) {
    this.eventHandlers.set(topic, handler)
  }

  rpc(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextRpcId++
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject
      })
    })
    this.sendFrame(FrameType.RPC_REQ, { id, method, params })
    return promise
  }

  emit(topic, payload) {
    this.sendFrame(FrameType.EVENT, { topic, payload })
  }

  async #onFrame(frame) {
    const type = frame[0]
    const body = frame.subarray(1)

    if (type === FrameType.FILE_CHUNK) return this.#onChunk(body)

    const message = body.length ? JSON.parse(decoder.decode(body)) : {}
    switch (type) {
      case FrameType.RPC_REQ: {
        const handler = this.rpcHandlers.get(message.method)
        if (!handler) {
          this.sendFrame(FrameType.RPC_RES, {
            id: message.id,
            ok: false,
            error: `no handler for ${message.method}`
          })
          return
        }
        try {
          const result = await handler(message.params, this)
          this.sendFrame(FrameType.RPC_RES, { id: message.id, ok: true, result })
        } catch (error) {
          this.sendFrame(FrameType.RPC_RES, { id: message.id, ok: false, error: error.message })
        }
        return
      }
      case FrameType.RPC_RES: {
        const waiter = this.pending.get(message.id)
        if (!waiter) return
        this.pending.delete(message.id)
        if (message.ok) waiter.resolve(message.result)
        else waiter.reject(new Error(message.error))
        return
      }
      case FrameType.EVENT: {
        this.eventHandlers.get(message.topic)?.(message.payload, this)
        this.eventHandlers.get('*')?.(message, this)
        return
      }
      case FrameType.FILE_MANIFEST:
        return this.#onManifest(message)
      case FrameType.FILE_WANT: {
        this.wantResolvers?.get(message.fileId)?.(message)
        return
      }
      case FrameType.FILE_ACK: {
        const state = this.sending?.get(message.fileId)
        if (state) {
          state.acked = message.upTo
          state.onCredit?.()
        }
        return
      }
      case FrameType.FILE_DONE: {
        const waiter = this.fileWaiters.get(message.fileId)
        if (waiter) {
          this.fileWaiters.delete(message.fileId)
          waiter(message)
        }
        return
      }
      default:
        this.log?.wire(`${this.name}: unknown frame type 0x${type.toString(16)}`)
    }
  }

  // -------------------------------------------------------------- file engine

  /** Where incoming files and their resume checkpoints are written. */
  configureReceiver({ directory, partDirectory, onProgress, onComplete }) {
    this.receiveDir = directory
    this.partDir = partDirectory
    this.onFileProgress = onProgress
    this.onFileComplete = onComplete
  }

  async #onManifest(manifest) {
    await fs.mkdir(this.receiveDir, { recursive: true })
    await fs.mkdir(this.partDir, { recursive: true })
    const partPath = path.join(this.partDir, `${manifest.fileId}.part`)
    const checkpointPath = path.join(this.partDir, `${manifest.fileId}.json`)

    // Resume: trust the checkpoint only as far as the bytes actually on disk.
    let from = 0
    try {
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, 'utf8'))
      const stat = await fs.stat(partPath)
      if (checkpoint.sha256 === manifest.sha256) {
        from = Math.min(checkpoint.received, Math.floor(stat.size / manifest.chunkSize))
      }
    } catch {
      from = 0
    }

    const handle = await fs.open(partPath, from > 0 ? 'r+' : 'w')
    const state = {
      manifest,
      handle,
      partPath,
      checkpointPath,
      received: from,
      startedAt: Date.now(),
      bytes: from * manifest.chunkSize
    }
    this.receiving.set(manifest.fileId, state)

    // A zero-byte file has no chunks to wait for: the empty part file created
    // above is already the whole thing.
    if (manifest.count === 0) {
      this.sendFrame(FrameType.FILE_WANT, { fileId: manifest.fileId, from: 0 })
      await this.#finishReceive(manifest.fileId, state)
      return
    }
    if (from > 0) {
      this.log?.mobile(
        `resuming ${manifest.name} from chunk ${from}/${manifest.count} ` +
          `(${((from / manifest.count) * 100).toFixed(0)}% already on disk)`
      )
    }
    this.sendFrame(FrameType.FILE_WANT, { fileId: manifest.fileId, from })
  }

  async #onChunk(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
    const fileId = view.getUint32(0).toString(16).padStart(8, '0')
    const index = view.getUint32(4)
    const data = body.subarray(8)
    const state = this.receiving.get(fileId)
    if (!state) return

    await state.handle.write(data, 0, data.length, index * state.manifest.chunkSize)
    state.received = Math.max(state.received, index + 1)
    state.bytes += data.length

    if (state.received % ACK_EVERY === 0 || state.received === state.manifest.count) {
      await fs.writeFile(
        state.checkpointPath,
        JSON.stringify({ received: state.received, sha256: state.manifest.sha256 })
      )
      this.sendFrame(FrameType.FILE_ACK, { fileId, upTo: state.received })
      this.onFileProgress?.(state)
    }

    if (state.received === state.manifest.count) await this.#finishReceive(fileId, state)
  }

  async #finishReceive(fileId, state) {
    await state.handle.close()
    const digest = await hashFile(state.partPath)
    const ok = digest === state.manifest.sha256
    const destination = path.join(this.receiveDir, state.manifest.name)
    if (ok) {
      await fs.rename(state.partPath, destination)
      await fs.rm(state.checkpointPath, { force: true })
    }
    this.receiving.delete(fileId)
    this.sendFrame(FrameType.FILE_DONE, { fileId, ok, sha256: digest })
    this.onFileComplete?.({
      name: state.manifest.name,
      size: state.manifest.size,
      ok,
      destination,
      ms: Date.now() - state.startedAt,
      resumed: state.manifest.count !== state.received
    })
  }

  /**
   * Streams a file through the tunnel: manifest → wait for WANT → windowed
   * chunks → DONE. Throws {@link Disconnected} if the socket dies mid-flight;
   * calling it again after reconnecting resumes from the receiver's checkpoint.
   */
  async sendFile(filePath, { name, mime, sha256, size, onProgress } = {}) {
    const stat = await fs.stat(filePath)
    const fileSize = size ?? stat.size
    const digest = sha256 ?? (await hashFile(filePath))
    const fileId = digest.slice(0, 8)
    const fileName = name ?? path.basename(filePath)
    const count = Math.ceil(fileSize / CHUNK_SIZE) // 0 for an empty file

    this.sending ??= new Map()
    this.wantResolvers ??= new Map()
    const state = { acked: 0, onCredit: null }
    this.sending.set(fileId, state)

    const want = new Promise((resolve, reject) => {
      this.wantResolvers.set(fileId, resolve)
      setTimeout(() => reject(new Error('no FILE_WANT from peer')), 30_000)
    })
    const done = new Promise((resolve, reject) => {
      this.fileWaiters.set(fileId, resolve)
      this.fileDoneRejects ??= new Map()
      this.fileDoneRejects.set(fileId, reject)
    })
    // The send loop can throw before anything awaits `done` (a dropout aborts
    // both at once). Attach a sink so that rejection is never "unhandled" —
    // callers that do await it still see the error.
    done.catch(() => {})

    this.sendFrame(FrameType.FILE_MANIFEST, {
      fileId,
      name: fileName,
      size: fileSize,
      chunkSize: CHUNK_SIZE,
      count,
      sha256: digest,
      mime: mime ?? 'application/octet-stream'
    })

    const from = (await want).from
    state.acked = from
    const startedAt = Date.now()

    try {
      return await this.#streamChunks({
        filePath,
        from,
        fileId,
        count,
        state,
        startedAt,
        onProgress,
        done
      })
    } finally {
      this.sending.delete(fileId)
      this.wantResolvers.delete(fileId)
      this.fileDoneRejects.delete(fileId)
      this.fileWaiters.delete(fileId)
    }
  }

  async #streamChunks({ filePath, from, fileId, count, state, startedAt, onProgress, done }) {
    let index = from
    let sentBytes = 0
    const stream = createReadStream(filePath, {
      start: from * CHUNK_SIZE,
      highWaterMark: CHUNK_SIZE
    })
    for await (const piece of stream) {
      // Some reads come back short; re-slice so every frame is exactly one chunk.
      for (let offset = 0; offset < piece.length; offset += CHUNK_SIZE) {
        const data = piece.subarray(offset, offset + CHUNK_SIZE)
        while (index - state.acked >= WINDOW) {
          if (this.closed || !this.peerPresent) throw new Disconnected('while awaiting credit')
          await new Promise((resolve) => {
            state.onCredit = resolve
            setTimeout(resolve, 250)
          })
        }
        if (this.closed || !this.peerPresent) throw new Disconnected('mid-transfer')
        const frame = new Uint8Array(8 + data.length)
        const header = new DataView(frame.buffer)
        header.setUint32(0, parseInt(fileId, 16))
        header.setUint32(4, index)
        frame.set(data, 8)
        const body = new Uint8Array(1 + frame.length)
        body[0] = FrameType.FILE_CHUNK
        body.set(frame, 1)
        this.#sendCiphertext(this.sendCipher.encrypt(body), 'file chunk')
        index += 1
        sentBytes += data.length
        onProgress?.({ index, count, sentBytes, ms: Date.now() - startedAt })
      }
    }

    const result = await done
    return { ...result, ms: Date.now() - startedAt, sentBytes, resumedFrom: from, count }
  }

  close(code = 1000, reason = 'done') {
    clearInterval(this.keepalive)
    try {
      this.ws?.close(code, reason)
    } catch {
      /* already gone */
    }
  }

  /** Rip the socket away without a close frame — the ugly disconnect a phone
   * losing signal actually produces. */
  kill() {
    clearInterval(this.keepalive)
    this.ws?.terminate()
  }
}

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

function frameName(type) {
  return Object.entries(FrameType).find(([, v]) => v === type)?.[0] ?? `0x${type.toString(16)}`
}
