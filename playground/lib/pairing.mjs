/**
 * Pairing codes — the typed alternative to scanning a QR.
 *
 * The QR payload is ~230 characters, most of it the desktop's public key. A
 * typed code cannot carry that, so code pairing uses Noise XXpsk3 instead
 * (see noise.mjs): both static keys are exchanged inside the handshake, and the
 * code only has to carry the secret. Everything after pairing is identical —
 * both devices end up holding pinned keys and reconnect with IKpsk2.
 *
 * The code is 8 characters of Crockford base32 — 40 bits. Guessing it means one
 * network round trip per attempt against a code that lives for minutes, so the
 * entropy is ample without needing a PAKE. Crockford's alphabet omits I, L, O
 * and U, and decoding folds the look-alikes, so `whittling` a code down the
 * phone by voice does not fail on O-versus-zero.
 */
import { randomBytes } from 'node:crypto'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford: no I, L, O, U
const CODE_CHARS = 8 // 40 bits
export const CODE_TTL_MS = 3 * 60 * 1000 // a typed code should not outlive the moment

/** A fresh pairing code, formatted for reading aloud: `K7M9-2QXR`. */
export function generateCode() {
  const bytes = randomBytes(CODE_CHARS)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * Accepts what a human actually types: lower case, missing or extra dashes,
 * spaces, and the classic look-alike substitutions.
 */
export function normalizeCode(input) {
  const folded = String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (folded.length !== CODE_CHARS) throw new Error(`a pairing code is ${CODE_CHARS} characters`)
  for (const character of folded) {
    if (!ALPHABET.includes(character))
      throw new Error(`"${character}" is not a pairing-code character`)
  }
  return folded
}

/** The 32-byte pairing secret a code stands for. Same role as the QR's secret. */
export function secretFromCode(code) {
  const normalized = normalizeCode(code)
  return hmac(
    sha256,
    new TextEncoder().encode('wolffish-pair-code-v1'),
    new TextEncoder().encode(normalized)
  )
}

/** True while a code issued at `issuedAt` is still usable. */
export function codeIsLive(issuedAt, now) {
  return now - issuedAt < CODE_TTL_MS
}
