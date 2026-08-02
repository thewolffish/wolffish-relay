/**
 * Noise_IKpsk2_25519_ChaChaPoly_SHA256 — the tunnel's pairing handshake.
 *
 * Why this pattern: the mobile (initiator) learns the desktop's static public
 * key from the QR code, while the desktop does not yet know the mobile's — that
 * asymmetry is exactly Noise IK. The QR's 32-byte pairing secret is mixed in as
 * the PSK, so only the device that actually scanned the code can complete the
 * handshake: a hostile relay that knows the rendezvous ID still cannot
 * man-in-the-middle the pairing. Ephemeral keys on both sides give forward
 * secrecy, so a stolen static key cannot decrypt past sessions.
 *
 *   IKpsk2:
 *     <- s                       (desktop static, carried by the QR)
 *     ...
 *     -> e, es, s, ss            message 1: mobile → desktop
 *     <- e, ee, se, psk          message 2: desktop → mobile
 *
 * Implemented straight from the Noise spec's processing rules (§5) so the
 * protocol package can inherit it. Pure JS via @noble — the same code runs on
 * Node, in Electron, and on Hermes.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

export const PROTOCOL_NAME = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256'
export const KEY_LEN = 32
export const TAG_LEN = 16

const EMPTY = new Uint8Array(0)

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function generateKeypair() {
  const { secretKey, publicKey } = x25519.keygen()
  return { privateKey: secretKey, publicKey }
}

const dh = (privateKey, publicKey) => x25519.getSharedSecret(privateKey, publicKey)

/** Noise HKDF: 1–3 outputs chained from the running chaining key. */
function hkdf(chainingKey, ikm, outputs) {
  const tempKey = hmac(sha256, chainingKey, ikm)
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1))
  if (outputs === 1) return [o1]
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)))
  if (outputs === 2) return [o1, o2]
  const o3 = hmac(sha256, tempKey, concat(o2, Uint8Array.of(3)))
  return [o1, o2, o3]
}

/** Noise nonce: 4 zero bytes followed by a 64-bit little-endian counter. */
function nonceBytes(counter) {
  const nonce = new Uint8Array(12)
  new DataView(nonce.buffer).setBigUint64(4, counter, true)
  return nonce
}

/** One direction of the post-handshake transport. */
export class CipherState {
  constructor(key) {
    this.key = key
    this.counter = 0n
  }

  encrypt(plaintext, ad = EMPTY) {
    const out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).encrypt(plaintext)
    this.counter += 1n
    return out
  }

  decrypt(ciphertext, ad = EMPTY) {
    const out = chacha20poly1305(this.key, nonceBytes(this.counter), ad).decrypt(ciphertext)
    this.counter += 1n
    return out
  }
}

class SymmetricState {
  constructor(protocolName) {
    const name = new TextEncoder().encode(protocolName)
    this.h = name.length <= 32 ? concat(name, new Uint8Array(32 - name.length)) : sha256(name)
    this.ck = this.h.slice()
    this.k = null
    this.n = 0n
  }

  mixHash(data) {
    this.h = sha256(concat(this.h, data))
  }

  mixKey(ikm) {
    const [ck, k] = hkdf(this.ck, ikm, 2)
    this.ck = ck
    this.k = k
    this.n = 0n
  }

  mixKeyAndHash(ikm) {
    const [ck, tempH, k] = hkdf(this.ck, ikm, 3)
    this.ck = ck
    this.mixHash(tempH)
    this.k = k
    this.n = 0n
  }

  encryptAndHash(plaintext) {
    if (!this.k) {
      this.mixHash(plaintext)
      return plaintext
    }
    const ciphertext = chacha20poly1305(this.k, nonceBytes(this.n), this.h).encrypt(plaintext)
    this.n += 1n
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext) {
    if (!this.k) {
      this.mixHash(ciphertext)
      return ciphertext
    }
    const plaintext = chacha20poly1305(this.k, nonceBytes(this.n), this.h).decrypt(ciphertext)
    this.n += 1n
    this.mixHash(ciphertext)
    return plaintext
  }

  split() {
    return hkdf(this.ck, EMPTY, 2).map((key) => new CipherState(key))
  }
}

/**
 * Initiator (mobile). Knows the desktop's static key and the pairing secret
 * because it scanned the QR.
 */
export class Initiator {
  constructor({ staticKeypair, remoteStaticPublicKey, psk, prologue = EMPTY }) {
    this.s = staticKeypair
    this.rs = remoteStaticPublicKey
    this.psk = psk
    this.state = new SymmetricState(PROTOCOL_NAME)
    this.state.mixHash(prologue)
    this.state.mixHash(this.rs) // pre-message: <- s
  }

  writeMessage1(payload = EMPTY) {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    this.state.mixKey(dh(this.e.privateKey, this.rs)) // es
    const encryptedStatic = this.state.encryptAndHash(this.s.publicKey)
    this.state.mixKey(dh(this.s.privateKey, this.rs)) // ss
    return concat(this.e.publicKey, encryptedStatic, this.state.encryptAndHash(payload))
  }

  readMessage2(message) {
    const re = message.subarray(0, KEY_LEN)
    this.state.mixHash(re)
    this.state.mixKey(dh(this.e.privateKey, re)) // ee
    this.state.mixKey(dh(this.s.privateKey, re)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const payload = this.state.decryptAndHash(message.subarray(KEY_LEN))
    const [send, receive] = this.state.split()
    return { payload, send, receive, handshakeHash: this.state.h }
  }
}

/**
 * Responder (desktop). Holds the static key advertised in the QR and the same
 * pairing secret; learns the mobile's static key from message 1 and pins it.
 */
export class Responder {
  constructor({ staticKeypair, psk, prologue = EMPTY }) {
    this.s = staticKeypair
    this.psk = psk
    this.state = new SymmetricState(PROTOCOL_NAME)
    this.state.mixHash(prologue)
    this.state.mixHash(this.s.publicKey) // pre-message: <- s
  }

  readMessage1(message) {
    this.re = message.subarray(0, KEY_LEN)
    this.state.mixHash(this.re)
    this.state.mixKey(dh(this.s.privateKey, this.re)) // es
    const encryptedStatic = message.subarray(KEY_LEN, KEY_LEN + KEY_LEN + TAG_LEN)
    this.rs = this.state.decryptAndHash(encryptedStatic) // peer's static key — pin this
    this.state.mixKey(dh(this.s.privateKey, this.rs)) // ss
    const payload = this.state.decryptAndHash(message.subarray(KEY_LEN + KEY_LEN + TAG_LEN))
    return { payload, remoteStaticPublicKey: this.rs }
  }

  writeMessage2(payload = EMPTY) {
    this.e = generateKeypair()
    this.state.mixHash(this.e.publicKey)
    this.state.mixKey(dh(this.e.privateKey, this.re)) // ee
    this.state.mixKey(dh(this.e.privateKey, this.rs)) // se
    this.state.mixKeyAndHash(this.psk) // psk
    const message = concat(this.e.publicKey, this.state.encryptAndHash(payload))
    const [receive, send] = this.state.split() // mirror of the initiator's split
    return { message, send, receive, handshakeHash: this.state.h }
  }
}
