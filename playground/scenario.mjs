/**
 * The full tunnel cycle, as an ordered list of phases.
 *
 * Each phase is `{ title, detail, run(ctx) }` and shares one context object, so
 * adding a case to the drive means appending an entry here — nothing else in
 * the harness needs to know about it.
 *
 * The cycle mirrors what the shipped product will do, in order: pair by QR,
 * hand-shake, prove the wire is opaque, resist intruders, sync configs and
 * conversations, run a live agent turn, move real files (including a 248 MB
 * PDF), survive the phone dropping mid-transfer, and verify every byte landed.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import QRCode from 'qrcode'
import { createDesktop, createMobile } from './lib/devices.mjs'
import * as fixtures from './lib/fixtures.mjs'
import { bytes, duration, speed } from './lib/log.mjs'
import { CipherState, generateKeypair } from './lib/noise.mjs'
import * as pairing from './lib/pairing.mjs'
import { Disconnected, hashFile, Tunnel, Wiretap } from './lib/tunnel.mjs'

const hex = (u8) => Buffer.from(u8).toString('hex')

/** rid = HMAC(pairing secret, "rid-v1") — unguessable, and meaningless to the relay. */
export const rendezvousId = (psk) => hex(hmac(sha256, psk, new TextEncoder().encode('rid-v1')))

export const phases = [
  {
    title: 'Stage from the published demo dataset',
    detail: 'manifest, conversations, config and files — all from the CDN',
    async run(ctx) {
      const { log, dirs } = ctx

      const manifest = await fixtures.loadDemoManifest(dirs.cache, log)
      const desktopConfig = await fixtures.loadDemoConfig(manifest, dirs.cache, log)
      const conversations = await fixtures.loadDemoConversations(manifest, dirs.cache, 12, log)
      const files = await fixtures.selectSampleFiles(dirs.desktopFiles, dirs.cache, log)
      const mobileUploads = await fixtures.selectMobileUploads(dirs.mobileOutbox, dirs.cache, log)

      ctx.fixtures = {
        manifest,
        desktopConfig,
        conversations,
        indexRows: fixtures.toIndexRows(conversations),
        files,
        mobileUploads
      }

      if (!ctx.options.quick) {
        ctx.fixtures.bigFile = await fixtures.stageBigPdf({
          cacheDir: dirs.cache,
          desktopDir: dirs.desktopFiles,
          log
        })
      }

      log.check(
        manifest.conversations > 0 && manifest.shards.length > 0,
        'demo manifest fetched from the CDN',
        `version ${manifest.version}`
      )
      log.check(conversations.length === 12, 'demo conversations loaded', `${conversations.length}`)
      log.check(files.length >= 8, 'file spread staged', `${files.length} files`)
      log.check(
        Boolean(ctx.fixtures.bigFile) || ctx.options.quick,
        'large PDF staged',
        ctx.fixtures.bigFile ? bytes(ctx.fixtures.bigFile.size) : 'skipped (quick run)'
      )
    }
  },

  {
    title: 'Pair by QR code',
    detail: 'desktop shows, mobile scans, both derive the same rendezvous ID',
    async run(ctx) {
      const { log, dirs } = ctx

      // Desktop side: long-lived identity + a fresh 32-byte pairing secret.
      ctx.desktopKeys = generateKeypair()
      ctx.mobileKeys = generateKeypair()
      const psk = randomBytes(32)
      ctx.psk = new Uint8Array(psk)

      const payload = {
        v: 1,
        relay: ctx.relayUrl,
        pk: hex(ctx.desktopKeys.publicKey),
        ps: psk.toString('base64url')
      }
      const qrText = `wolffish-pair:v1:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
      const qrPath = path.join(dirs.desktop, 'pairing-qr.png')
      await QRCode.toFile(qrPath, qrText, { margin: 2, width: 512 })
      await fs.writeFile(path.join(dirs.desktop, 'pairing-payload.txt'), qrText)
      log.desktop(`QR generated — ${qrText.length} chars, saved to desktop/pairing-qr.png`)
      ctx.qr = {
        text: qrText,
        path: qrPath,
        terminal: await QRCode.toString(qrText, { type: 'terminal', small: true })
      }

      // Mobile side: decode exactly what the QR carries.
      const [, , encoded] = qrText.split(':')
      const scanned = JSON.parse(Buffer.from(encoded, 'base64url').toString())
      const scannedPsk = new Uint8Array(Buffer.from(scanned.ps, 'base64url'))
      log.mobile(`scanned QR — relay ${scanned.relay}, desktop key ${scanned.pk.slice(0, 16)}…`)

      const ridDesktop = rendezvousId(ctx.psk)
      const ridMobile = rendezvousId(scannedPsk)
      ctx.rid = ridDesktop
      ctx.scanned = scanned

      log.check(scanned.pk === hex(ctx.desktopKeys.publicKey), 'QR carries the desktop static key')
      log.check(
        ridDesktop === ridMobile,
        'both sides derive the same rendezvous ID',
        `${ridDesktop.slice(0, 16)}…`
      )
      log.check(/^[0-9a-f]{64}$/.test(ridDesktop), 'rendezvous ID is 256-bit lowercase hex')
    }
  },

  {
    title: 'Pair by typed code',
    detail: 'the other route in: no camera, no QR, same end state',
    async run(ctx) {
      const { log } = ctx

      // Desktop shows a code instead of a QR. Eight Crockford characters —
      // 40 bits, readable down a phone line.
      const shown = pairing.generateCode()
      const issuedAt = Date.now()
      log.desktop(
        `pairing code displayed: ${shown}  (expires in ${pairing.CODE_TTL_MS / 60000} min)`
      )

      // The phone's user types it, badly: lower case, no dash, and the classic
      // look-alikes. Normalisation has to absorb all of it.
      const typed = shown.replace('-', '').toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')
      log.mobile(`typed: "${typed}"`)
      log.check(
        Buffer.compare(
          Buffer.from(pairing.secretFromCode(typed)),
          Buffer.from(pairing.secretFromCode(shown))
        ) === 0,
        'a sloppily typed code still derives the same secret',
        'case, dashes and O/0 · I/L/1 folded'
      )
      log.check(pairing.codeIsLive(issuedAt, Date.now()), 'the code is still within its lifetime')

      const rejected = ['ABC', 'TOO-SHORT-BY-FAR-XX', 'ABCD-EF!$'].filter((bad) => {
        try {
          pairing.normalizeCode(bad)
          return false
        } catch {
          return true
        }
      })
      log.check(rejected.length === 3, 'malformed codes are rejected before any connection is made')

      const distinct = new Set(
        Array.from({ length: 200 }, () =>
          Buffer.from(pairing.secretFromCode(pairing.generateCode())).toString('hex')
        )
      )
      log.check(distinct.size === 200, 'generated codes do not collide', '200 samples, 200 secrets')

      const codeSecret = new Uint8Array(pairing.secretFromCode(typed))
      const codeRid = rendezvousId(codeSecret)
      log.check(
        /^[0-9a-f]{64}$/.test(codeRid),
        'the code derives a rendezvous ID',
        `${codeRid.slice(0, 16)}…`
      )

      // A different code must lead somewhere else entirely.
      const otherRid = rendezvousId(new Uint8Array(pairing.secretFromCode(pairing.generateCode())))
      log.check(otherRid !== codeRid, 'a different code meets at a different rendezvous')

      // Fresh identities: this pairing knows nothing in advance.
      const deskKeys = generateKeypair()
      const phoneKeys = generateKeypair()
      const desk = new Tunnel({
        role: 'host',
        relayUrl: ctx.relayUrl,
        rid: codeRid,
        name: 'desktop',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })
      const phone = new Tunnel({
        role: 'guest',
        relayUrl: ctx.relayUrl,
        rid: codeRid,
        name: 'mobile',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })
      await desk.connect()
      await phone.connect()
      await Promise.all([desk.waitForPeer(), phone.waitForPeer()])

      const started = Date.now()
      const [deskSide, phoneSide] = await Promise.all([
        desk.handshakeAsResponderCode({
          staticKeypair: deskKeys,
          psk: codeSecret,
          payload: { device: 'wolffish-app', pairedBy: 'code' }
        }),
        phone.handshakeAsInitiatorCode({
          staticKeypair: phoneKeys,
          psk: codeSecret,
          payload: { device: 'wolffish-mobile', pairedBy: 'code' }
        })
      ])
      const ms = Date.now() - started
      log.desktop(
        `XXpsk3 handshake complete in ${ms} ms — neither side knew the other's key beforehand`
      )

      log.check(
        deskSide.peerStaticKey === hex(phoneKeys.publicKey),
        'desktop learned and pinned the phone key it was never told'
      )
      log.check(
        phoneSide.peerStaticKey === hex(deskKeys.publicKey),
        'phone learned and pinned the desktop key the code did not carry'
      )
      log.check(
        desk.handshakeHash === phone.handshakeHash,
        'both sides agree on the handshake transcript hash',
        `${desk.handshakeHash.slice(0, 24)}…`
      )
      log.check(phoneSide.payload.pairedBy === 'code', 'identities exchanged inside the handshake')

      // It has to be a working tunnel, not just a successful handshake.
      desk.onRpc('system.check', async () => ({ ok: true, pairedBy: 'code' }))
      phone.configureReceiver({
        directory: ctx.dirs.mobileFiles,
        partDirectory: ctx.dirs.parts
      })
      const health = await phone.rpc('system.check')
      log.check(health.ok === true, 'RPC works over a code-paired tunnel')

      const sample = ctx.fixtures.files.find((f) => f.size > 1000) ?? ctx.fixtures.files[0]
      const sent = await desk.sendFile(path.join(ctx.dirs.desktopFiles, sample.name), {
        name: `code-paired-${sample.name}`
      })
      log.check(sent.ok, `file delivered over a code-paired tunnel`, `${bytes(sample.size)}`)

      // The whole point: after pairing, a code-paired device is indistinguishable
      // from a QR-paired one — it reconnects with IKpsk2 against pinned keys.
      desk.close(1000, 'code pairing done')
      phone.close(1000, 'code pairing done')
      await sleep(400)

      const deskAgain = new Tunnel({
        role: 'host',
        relayUrl: ctx.relayUrl,
        rid: codeRid,
        name: 'desktop',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })
      const phoneAgain = new Tunnel({
        role: 'guest',
        relayUrl: ctx.relayUrl,
        rid: codeRid,
        name: 'mobile',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })
      await deskAgain.connect()
      await phoneAgain.connect()
      await Promise.all([deskAgain.waitForPeer(), phoneAgain.waitForPeer()])
      const [reDesk] = await Promise.all([
        deskAgain.handshakeAsResponder({
          staticKeypair: deskKeys,
          psk: codeSecret,
          payload: { device: 'wolffish-app', resumed: true }
        }),
        phoneAgain.handshakeAsInitiator({
          staticKeypair: phoneKeys,
          // The key the phone pinned during code pairing — no QR ever existed.
          remoteStaticPublicKey: new Uint8Array(Buffer.from(phoneSide.peerStaticKey, 'hex')),
          psk: codeSecret,
          payload: { device: 'wolffish-mobile', resumed: true }
        })
      ])
      log.check(
        reDesk.peerStaticKey === hex(phoneKeys.publicKey),
        'code-paired devices reconnect with IKpsk2 against their pinned keys',
        'identical to a QR pairing from here on'
      )
      deskAgain.onRpc('system.check', async () => ({ ok: true, reconnected: true }))
      const after = await phoneAgain.rpc('system.check')
      log.check(after.ok === true, 'the reconnected code-paired tunnel carries traffic')

      deskAgain.close(1000, 'done')
      phoneAgain.close(1000, 'done')
      ctx.results.codePairing = { code: shown, handshakeMs: ms, bytes: sample.size }
    }
  },

  {
    title: 'Connect and hand-shake',
    detail: 'Noise IKpsk2 over the live relay',
    async run(ctx) {
      const { log } = ctx
      ctx.wiretap = new Wiretap(14)

      ctx.desktop = new Tunnel({
        role: 'host',
        relayUrl: ctx.relayUrl,
        rid: ctx.rid,
        name: 'desktop',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })
      ctx.mobile = new Tunnel({
        role: 'guest',
        relayUrl: ctx.relayUrl,
        rid: ctx.rid,
        name: 'mobile',
        log,
        wiretap: ctx.wiretap,
        lookup: ctx.lookup
      })

      await ctx.desktop.connect()
      log.desktop('parked on the relay as host')
      await ctx.mobile.connect()
      log.mobile('dialled the relay as guest')
      await Promise.all([ctx.desktop.waitForPeer(), ctx.mobile.waitForPeer()])

      const started = Date.now()
      const [responderResult, initiatorPayload] = await Promise.all([
        ctx.desktop.handshakeAsResponder({
          staticKeypair: ctx.desktopKeys,
          psk: ctx.psk,
          payload: { device: 'wolffish-app', platform: 'darwin', proto: 1 }
        }),
        ctx.mobile.handshakeAsInitiator({
          staticKeypair: ctx.mobileKeys,
          remoteStaticPublicKey: new Uint8Array(Buffer.from(ctx.scanned.pk, 'hex')),
          psk: new Uint8Array(Buffer.from(ctx.scanned.ps, 'base64url')),
          payload: { device: 'wolffish-mobile', platform: 'ios', proto: 1 }
        })
      ])
      const ms = Date.now() - started
      ctx.handshakeMs = ms

      log.desktop(
        `handshake complete in ${ms} ms — pinned mobile key ${responderResult.peerStaticKey.slice(0, 16)}…`
      )
      log.check(
        responderResult.peerStaticKey === hex(ctx.mobileKeys.publicKey),
        'desktop pinned the real mobile static key'
      )
      log.check(
        ctx.desktop.handshakeHash === ctx.mobile.handshakeHash,
        'both sides agree on the handshake transcript hash',
        `${ctx.desktop.handshakeHash.slice(0, 24)}…`
      )
      log.check(initiatorPayload.device === 'wolffish-app', 'desktop identity received by mobile')
      log.check(
        responderResult.payload.device === 'wolffish-mobile',
        'mobile identity received by desktop'
      )

      // Wire both roles up with their behaviour.
      ctx.desktopDevice = createDesktop({
        tunnel: ctx.desktop,
        log,
        fixtures: ctx.fixtures,
        desktopDir: ctx.dirs.desktopFiles
      })
      ctx.mobileDevice = createMobile({
        tunnel: ctx.mobile,
        log,
        mobileDir: ctx.dirs.mobile,
        outboxDir: ctx.dirs.mobileOutbox
      })
      ctx.mobile.configureReceiver({
        directory: ctx.dirs.mobileFiles,
        partDirectory: ctx.dirs.parts,
        onProgress: (state) => ctx.onFileProgress?.(state),
        onComplete: (result) => ctx.onFileComplete?.(result)
      })
      // The desktop receives too — the file engine is the same on both sides.
      ctx.desktop.configureReceiver({
        directory: ctx.dirs.desktopInbox,
        partDirectory: ctx.dirs.desktopParts,
        onComplete: (result) => ctx.onDesktopFileComplete?.(result)
      })
    }
  },

  {
    title: 'Prove the wire is opaque',
    detail: 'ciphertext audit on live frames plus integrity probes',
    async run(ctx) {
      const { log } = ctx

      // A round trip so there is real traffic to inspect — then enough more to
      // make the entropy figure mean something. A few hundred bytes of
      // handshake is too small a sample: even perfectly random data averages
      // only ~7.6 bits/byte at that size, purely from counting noise.
      const health = await ctx.mobile.rpc('system.check')
      log.check(health.ok === true, 'RPC round-trip over the encrypted tunnel')
      const { rows } = await ctx.mobile.rpc('conversations.list')
      for (const row of rows.slice(0, 3)) await ctx.mobile.rpc('conversation.get', { id: row.id })

      const samples = ctx.wiretap.samples
      log.wire(
        `captured ${ctx.wiretap.frameCount} frames (${bytes(ctx.wiretap.byteCount)}) as the relay sees them`
      )

      // 1. Nothing recognisable survives on the wire.
      const needles = [
        'wolffish-mobile',
        'system.check',
        'conversations',
        '%PDF',
        ctx.fixtures.indexRows[0]?.title?.slice(0, 12)
      ].filter(Boolean)
      const allHex = samples.map((s) => s.head).join('')
      const leaked = needles.filter((needle) =>
        allHex.includes(Buffer.from(needle).toString('hex'))
      )
      log.check(
        leaked.length === 0,
        'no plaintext markers found in captured ciphertext',
        `${needles.length} needles searched`
      )

      // 2. Ciphertext looks like noise, not like structured data. Measured over
      // the whole sampled corpus so the figure is statistically meaningful.
      const entropy = ctx.wiretap.entropy()
      const sampled = ctx.wiretap.histogramBytes
      // Shannon entropy is biased low on small samples by about
      // (256-1)/(2·n·ln2) bits, so compare against what truly random bytes
      // would score at this sample size rather than against a flat 8.0.
      const ceiling = 8 - 255 / (2 * sampled * Math.LN2)
      log.check(
        sampled > 4096 && entropy > ceiling - 0.05,
        'captured frames are indistinguishable from random',
        `${entropy.toFixed(3)} bits/byte over ${bytes(sampled)} (random would score ${ceiling.toFixed(3)})`
      )

      // 3. AEAD integrity: a flipped bit must be rejected, not silently accepted.
      const key = randomBytes(32)
      const probe = Buffer.from('conversation body the relay must never read')
      const sealed = new CipherState(new Uint8Array(key)).encrypt(new Uint8Array(probe))
      log.check(!Buffer.from(sealed).includes(probe), 'sealed frame does not contain its plaintext')

      const tampered = Uint8Array.from(sealed)
      tampered[10] ^= 0x01
      let tamperRejected = false
      try {
        new CipherState(new Uint8Array(key)).decrypt(tampered)
      } catch {
        tamperRejected = true
      }
      log.check(tamperRejected, 'a single flipped bit fails authentication')

      let wrongKeyRejected = false
      try {
        new CipherState(new Uint8Array(randomBytes(32))).decrypt(sealed)
      } catch {
        wrongKeyRejected = true
      }
      log.check(wrongKeyRejected, 'the wrong key cannot open a frame')

      const opened = Buffer.from(new CipherState(new Uint8Array(key)).decrypt(sealed))
      log.check(opened.equals(probe), 'the right key round-trips exactly')

      log.exhibit({
        kind: 'wire',
        frames: ctx.wiretap.frameCount,
        bytes: ctx.wiretap.byteCount,
        entropy,
        samples: samples.slice(0, 8)
      })
    }
  },

  {
    title: 'Resist intruders',
    detail: 'wrong rendezvous ID, and a scanner-less impostor',
    async run(ctx) {
      const { log } = ctx

      // An eavesdropper on a different rendezvous ID hears nothing.
      const strangerRid = rendezvousId(new Uint8Array(randomBytes(32)))
      const stranger = new Tunnel({
        role: 'guest',
        relayUrl: ctx.relayUrl,
        rid: strangerRid,
        name: 'stranger',
        log,
        lookup: ctx.lookup
      })
      await stranger.connect()
      let strangerHeard = 0
      stranger.ws.on('message', (_d, isBinary) => {
        if (isBinary) strangerHeard += 1
      })
      await ctx.mobile.rpc('system.check')
      await sleep(1200)
      log.check(strangerHeard === 0, 'a socket on another rendezvous ID receives nothing')
      stranger.close(1000, 'probe done')

      // An impostor who somehow learned the rendezvous ID but never scanned the
      // QR cannot complete the handshake: the PSK binds it to the scanner.
      const impostorRid = rendezvousId(new Uint8Array(randomBytes(32)))
      const victim = new Tunnel({
        role: 'host',
        relayUrl: ctx.relayUrl,
        rid: impostorRid,
        name: 'victim-desktop',
        log,
        lookup: ctx.lookup
      })
      const impostor = new Tunnel({
        role: 'guest',
        relayUrl: ctx.relayUrl,
        rid: impostorRid,
        name: 'impostor',
        log,
        lookup: ctx.lookup
      })
      await victim.connect()
      await impostor.connect()
      await Promise.all([victim.waitForPeer(), impostor.waitForPeer()])

      const victimKeys = generateKeypair()
      const realPsk = new Uint8Array(randomBytes(32))
      const guessedPsk = new Uint8Array(randomBytes(32)) // impostor never saw the QR

      let victimServedRpc = false
      victim.onRpc('anything', async () => {
        victimServedRpc = true
        return { ok: true }
      })

      const [victimSide, impostorSide] = await Promise.allSettled([
        victim.handshakeAsResponder({ staticKeypair: victimKeys, psk: realPsk, payload: {} }),
        impostor.handshakeAsInitiator({
          staticKeypair: generateKeypair(),
          remoteStaticPublicKey: victimKeys.publicKey, // public — no secret needed
          psk: guessedPsk,
          payload: { device: 'impostor' }
        })
      ])

      log.check(
        impostorSide.status === 'rejected',
        'impostor cannot finish the handshake without the QR secret',
        'knowing the rendezvous ID is not enough'
      )
      log.check(
        impostor.handshakeDone !== true,
        'impostor derived no session keys — it can neither read nor write'
      )

      // The responder does derive keys (in IKpsk2 it cannot detect a wrong PSK
      // until a transport frame arrives) — so prove the frames never validate.
      const forged = new CipherState(new Uint8Array(randomBytes(32))).encrypt(
        new Uint8Array(Buffer.from(JSON.stringify({ id: 1, method: 'anything', params: {} })))
      )
      impostor.ws.send(forged)
      await sleep(800)
      log.check(
        victimSide.status === 'fulfilled' && !victimServedRpc,
        'forged frames are rejected — the impostor cannot drive the desktop',
        'responder keys exist but nothing authenticates against them'
      )
      victim.close(1000, 'probe done')
      impostor.close(1000, 'probe done')

      // The live session is untouched by any of it.
      const stillAlive = await ctx.mobile.rpc('system.check')
      log.check(stillAlive.ok === true, 'the real session survived the probes')
    }
  },

  {
    title: 'Sync configuration',
    detail: 'the desktop config.json, projected for a phone',
    async run(ctx) {
      const { log } = ctx
      const started = Date.now()
      const { config } = await ctx.mobile.rpc('config.get')
      const written = await ctx.mobileDevice.writeConfig(config)
      const ms = Date.now() - started

      const desktopSections = Object.keys(ctx.fixtures.desktopConfig).sort()
      const mobileSections = Object.keys(config).sort()
      log.check(
        JSON.stringify(desktopSections) === JSON.stringify(mobileSections),
        'every config section arrived',
        `${mobileSections.length} sections in ${ms} ms`
      )
      log.check(
        JSON.stringify(config).includes('«redacted:'),
        'credentials were replaced before leaving the desktop'
      )
      log.check(
        config.llm !== undefined &&
          config.capabilities !== undefined &&
          config.preferences !== undefined,
        'demo settings survived the trip',
        `${config.capabilities?.length ?? 0} capabilities · ${Object.keys(config.services ?? {}).length} services`
      )
      ctx.results.config = { sections: mobileSections.length, ms, size: written.size }
    }
  },

  {
    title: 'Sync conversations',
    detail: 'index first, then full bodies on demand',
    async run(ctx) {
      const { log } = ctx
      const started = Date.now()
      const { rows, total } = await ctx.mobile.rpc('conversations.list')
      await ctx.mobileDevice.writeConversationIndex(rows)
      log.check(
        rows.length === ctx.fixtures.indexRows.length,
        'conversation index delivered',
        `${rows.length}/${total}`
      )

      let restored = 0
      let restoredBytes = 0
      for (const row of rows.slice(0, 6)) {
        const conversation = await ctx.mobile.rpc('conversation.get', { id: row.id })
        await ctx.mobileDevice.writeConversation(conversation)
        const original = ctx.fixtures.conversations.find((c) => c.conversation.id === row.id)
        const identical = JSON.stringify(conversation) === JSON.stringify(original.conversation)
        if (identical) restored += 1
        restoredBytes += JSON.stringify(conversation).length
      }
      const ms = Date.now() - started
      log.check(
        restored === 6,
        'conversation bodies match the desktop byte for byte',
        `${restored}/6`
      )
      log.mobile(`restored ${restored} conversations (${bytes(restoredBytes)}) in ${duration(ms)}`)
      ctx.results.conversations = { rows: rows.length, restored, bytes: restoredBytes, ms }
    }
  },

  {
    title: 'Run a live conversation',
    detail: 'mobile asks, desktop streams a real agent turn back',
    async run(ctx) {
      const { log } = ctx
      // Pick the meatiest real turn available so the replay is worth watching.
      const source = [...ctx.fixtures.conversations].sort(
        (a, b) => longestAssistant(b.conversation) - longestAssistant(a.conversation)
      )[0]
      const prompt =
        source?.conversation.messages.find((m) => m.role === 'user')?.content?.slice(0, 200) ??
        'Summarise the workspace.'
      log.mobile(`asking: "${prompt.slice(0, 72).replace(/\s+/g, ' ')}…"`)

      const started = Date.now()
      const result = await ctx.mobile.rpc('agent.run', {
        prompt,
        conversationId: source.conversation.id
      })
      await sleep(150) // let the final deltas land
      const ms = Date.now() - started

      const transcript = ctx.mobileDevice.received.deltas.join('')
      await ctx.mobileDevice.writeTranscript(
        'live-turn.md',
        `# ${source.conversation.title}\n\n**Asked:** ${prompt}\n\n---\n\n${transcript}\n`
      )

      log.check(result.deltas > 0, 'agent streamed deltas to the phone', `${result.deltas} events`)
      log.check(
        transcript.length === result.chars,
        'streamed transcript reassembled exactly',
        `${transcript.length} chars`
      )
      log.check(
        ctx.mobileDevice.received.events.some((e) => e.topic === 'agent.tool'),
        'tool-run event delivered'
      )
      ctx.results.conversation = {
        title: source.conversation.title,
        chars: transcript.length,
        deltas: result.deltas,
        ms
      }
    }
  },

  {
    title: 'Move files',
    detail: 'published sample files plus deliberately awkward ones',
    async run(ctx) {
      const { log } = ctx
      const completions = []
      ctx.onFileComplete = (result) => completions.push(result)

      for (const file of ctx.fixtures.files) {
        const started = Date.now()
        try {
          const sent = await ctx.desktopDevice.pushFile(file)
          const ms = Math.max(1, Date.now() - started)
          const record = {
            name: file.name,
            size: file.size,
            source: file.source,
            ok: sent.ok,
            ms,
            speed: speed(file.size, ms),
            chunks: sent.count
          }
          log.transfer(record)
          log.check(
            sent.ok,
            `delivered ${file.name}`,
            `${bytes(file.size)} · ${duration(ms)} · ${record.speed}`
          )
        } catch (error) {
          log.check(false, `delivered ${file.name}`, error.message)
        }
      }

      log.check(
        completions.length === ctx.fixtures.files.length,
        'every file completed on the mobile side',
        `${completions.length}/${ctx.fixtures.files.length}`
      )
    }
  },

  {
    title: 'Reverse direction — the phone serves the desktop',
    detail: 'device tools, a remote invocation, and an upload',
    async run(ctx) {
      const { log } = ctx

      // Nothing about the tunnel favours the side that dialled out first: the
      // desktop now calls the phone, and the phone answers.
      const tools = await ctx.desktop.rpc('device.tools')
      log.desktop(
        `phone advertises ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`
      )
      log.check(tools.tools.length >= 4, "desktop fetched the phone's own tool definitions")

      const status = await ctx.desktop.rpc('device.status')
      log.check(
        typeof status.battery === 'number' && status.network === 'cellular',
        'desktop read live device status from the phone',
        `battery ${(status.battery * 100).toFixed(0)}% · ${status.network}`
      )

      const notified = await ctx.desktop.rpc('notify.send', {
        title: 'Sync complete',
        body: 'Your desktop finished the transfer.'
      })
      log.check(notified.shown === true, 'desktop invoked a tool that only the phone can run')

      // And the phone uploads a file the desktop never had.
      const uploads = ctx.fixtures.mobileUploads
      const completions = []
      ctx.onDesktopFileComplete = (result) => completions.push(result)

      for (const file of uploads) {
        const started = Date.now()
        const sent = file.name.startsWith('camera-capture')
          ? await ctx.desktop.rpc('camera.capture', { name: file.name }) // desktop asks; phone pushes
          : await ctx.mobile.sendFile(path.join(ctx.dirs.mobileOutbox, file.name), {
              name: file.name
            })
        const ms = Math.max(1, Date.now() - started)
        const record = {
          name: file.name,
          size: file.size,
          source: `${file.source} → desktop`,
          ok: sent.ok !== false,
          ms,
          speed: speed(file.size, ms)
        }
        log.transfer(record)
        log.check(record.ok, `phone uploaded ${file.name}`, `${bytes(file.size)} · ${duration(ms)}`)
      }

      // Verify on the desktop's disk, not just by return value.
      let matched = 0
      for (const file of uploads) {
        const landed = path.join(ctx.dirs.desktopInbox, file.name)
        try {
          const [a, b] = await Promise.all([
            hashFile(path.join(ctx.dirs.mobileOutbox, file.name)),
            hashFile(landed)
          ])
          if (a === b) matched += 1
        } catch {
          /* counted as a miss below */
        }
      }
      log.check(
        matched === uploads.length,
        'uploads are byte-identical on the desktop',
        `${matched}/${uploads.length}`
      )
      ctx.results.reverse = { tools: tools.tools.length, uploads: uploads.length, matched }
    }
  },

  {
    title: 'Move the 248 MB PDF, and survive a dropout',
    detail: 'the phone loses signal mid-transfer and resumes',
    skip: (ctx) => ctx.options.quick,
    async run(ctx) {
      const { log } = ctx
      const big = ctx.fixtures.bigFile
      const filePath = big.path
      const digest = await hashFile(filePath)
      log.desktop(`sending ${big.name} — ${bytes(big.size)}, sha256 ${digest.slice(0, 16)}…`)

      let interrupted = false
      let lastPercent = 0
      const startedAt = Date.now()

      const progress = ({ index, count, sentBytes, ms }) => {
        const percent = Math.floor((index / count) * 100)
        if (percent >= lastPercent + 10) {
          lastPercent = percent
          log.desktop(
            `  ${percent}% — ${bytes(sentBytes)} in ${duration(ms)} · ${speed(sentBytes, ms)}`
          )
        }
        // Rip the phone off the network partway through, once.
        if (!interrupted && percent >= 18) {
          interrupted = true
          log.mobile('*** signal lost — socket terminated mid-transfer ***')
          ctx.mobile.kill()
        }
      }

      let attempts = 0
      let done = null
      while (!done && attempts < 3) {
        attempts += 1
        try {
          done = await ctx.desktop.sendFile(filePath, {
            name: big.name,
            mime: 'application/pdf',
            sha256: digest,
            size: big.size,
            onProgress: progress
          })
        } catch (error) {
          if (!(error instanceof Disconnected)) throw error
          log.relay(`transfer aborted: ${error.message} — reconnecting the phone`)

          // The phone comes back: fresh socket, fresh session keys, same pairing.
          ctx.mobile = new Tunnel({
            role: 'guest',
            relayUrl: ctx.relayUrl,
            rid: ctx.rid,
            name: 'mobile',
            log,
            wiretap: ctx.wiretap,
            lookup: ctx.lookup
          })
          await ctx.mobile.connect()
          ctx.desktop.resetSession()
          await Promise.all([
            ctx.desktop.waitForPeer().then(() =>
              ctx.desktop.handshakeAsResponder({
                staticKeypair: ctx.desktopKeys,
                psk: ctx.psk,
                payload: { device: 'wolffish-app', resumed: true }
              })
            ),
            ctx.mobile.waitForPeer().then(() =>
              ctx.mobile.handshakeAsInitiator({
                staticKeypair: ctx.mobileKeys,
                remoteStaticPublicKey: new Uint8Array(Buffer.from(ctx.scanned.pk, 'hex')),
                psk: new Uint8Array(Buffer.from(ctx.scanned.ps, 'base64url')),
                payload: { device: 'wolffish-mobile', resumed: true }
              })
            )
          ])
          ctx.mobileDevice = createMobile({
            tunnel: ctx.mobile,
            log,
            mobileDir: ctx.dirs.mobile,
            outboxDir: ctx.dirs.mobileOutbox
          })
          ctx.mobile.configureReceiver({
            directory: ctx.dirs.mobileFiles,
            partDirectory: ctx.dirs.parts
          })
          log.mobile('reconnected and re-handshaked — asking to continue where it stopped')
        }
      }

      const ms = Date.now() - startedAt
      const landed = path.join(ctx.dirs.mobileFiles, big.name)
      const landedHash = await hashFile(landed)
      const { size: landedSize } = await fs.stat(landed)

      log.check(interrupted, 'the transfer really was interrupted mid-flight')
      log.check(
        done?.resumedFrom > 0,
        'transfer resumed from a checkpoint, not from zero',
        `chunk ${done?.resumedFrom}`
      )
      log.check(landedSize === big.size, 'delivered size matches', bytes(landedSize))
      log.check(landedHash === digest, 'sha256 matches end to end', `${landedHash.slice(0, 24)}…`)

      const record = {
        name: big.name,
        size: big.size,
        source: big.source,
        ok: landedHash === digest,
        ms,
        speed: speed(big.size, ms),
        chunks: done?.count,
        resumedFrom: done?.resumedFrom,
        interrupted: true
      }
      log.transfer(record)
      ctx.results.bigFile = record
      log.desktop(
        `${big.name} complete: ${bytes(big.size)} in ${duration(ms)} · ` +
          `${speed(big.size, ms)} (including the dropout and reconnect)`
      )
    }
  },

  {
    title: 'Verify delivery',
    detail: 'compare every artifact on both sides',
    async run(ctx) {
      const { log, dirs } = ctx
      const desktopFiles = await fs.readdir(dirs.desktopFiles)
      const mobileFiles = await fs.readdir(dirs.mobileFiles)

      let matched = 0
      const comparisons = []
      for (const name of desktopFiles) {
        if (!mobileFiles.includes(name)) {
          comparisons.push({ name, ok: false, note: 'missing on mobile' })
          continue
        }
        const [a, b] = await Promise.all([
          hashFile(path.join(dirs.desktopFiles, name)),
          hashFile(path.join(dirs.mobileFiles, name))
        ])
        const ok = a === b
        if (ok) matched += 1
        comparisons.push({
          name,
          ok,
          sha256: a,
          size: (await fs.stat(path.join(dirs.mobileFiles, name))).size
        })
      }
      ctx.results.comparisons = comparisons
      log.check(
        matched === desktopFiles.length,
        'every desktop file is byte-identical on the phone',
        `${matched}/${desktopFiles.length}`
      )

      const leftovers = (await fs.readdir(dirs.parts).catch(() => [])).filter((f) =>
        f.endsWith('.part')
      )
      log.check(
        leftovers.length === 0,
        'no partial files left behind',
        `${leftovers.length} stragglers`
      )

      ctx.results.totals = {
        files: comparisons.length,
        bytes: comparisons.reduce((n, c) => n + (c.size ?? 0), 0),
        wireBytes: ctx.wiretap.byteCount,
        frames: ctx.wiretap.frameCount
      }
    }
  }
]

const longestAssistant = (conversation) =>
  Math.max(
    0,
    ...conversation.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content?.length ?? 0)
  )

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
