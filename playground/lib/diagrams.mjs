/**
 * Inline SVG illustrations for the reference report. Everything uses the
 * document's CSS variables so the diagrams follow light/dark like the rest of
 * the page, and nothing is fetched from outside.
 */

const defs = `
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
    </marker>
    <marker id="arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
    </marker>
  </defs>`

/** Desktop and phone both dial *out*; the relay is only a meeting point. */
export const topology = () => `
<svg viewBox="0 0 900 300" role="img" aria-label="Both devices dial out to the relay; end-to-end encryption spans them">
  ${defs}
  <rect x="10" y="90" width="200" height="110" rx="12" fill="var(--card)" stroke="var(--line)" />
  <text x="110" y="122" text-anchor="middle" class="d-title">Desktop</text>
  <text x="110" y="144" text-anchor="middle" class="d-sub">wolffish-app · host</text>
  <text x="110" y="164" text-anchor="middle" class="d-sub">parks and waits</text>
  <text x="110" y="184" text-anchor="middle" class="d-tiny">behind home NAT</text>

  <rect x="345" y="80" width="210" height="130" rx="12" fill="var(--card)" stroke="var(--accent)" stroke-dasharray="4 3" />
  <text x="450" y="112" text-anchor="middle" class="d-title">relay.wolffi.sh</text>
  <text x="450" y="134" text-anchor="middle" class="d-sub">Worker + Durable Object</text>
  <text x="450" y="154" text-anchor="middle" class="d-sub">one instance per rendezvous ID</text>
  <text x="450" y="176" text-anchor="middle" class="d-tiny">RAM only · no disk · no logs</text>
  <text x="450" y="196" text-anchor="middle" class="d-tiny">forwards bytes it cannot read</text>

  <rect x="690" y="90" width="200" height="110" rx="12" fill="var(--card)" stroke="var(--line)" />
  <text x="790" y="122" text-anchor="middle" class="d-title">Phone</text>
  <text x="790" y="144" text-anchor="middle" class="d-sub">wolffish-mobile · guest</text>
  <text x="790" y="164" text-anchor="middle" class="d-sub">dials in when active</text>
  <text x="790" y="184" text-anchor="middle" class="d-tiny">behind carrier CGNAT</text>

  <line x1="215" y1="145" x2="340" y2="145" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <line x1="685" y1="145" x2="560" y2="145" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="277" y="134" text-anchor="middle" class="d-tiny">outbound wss</text>
  <text x="623" y="134" text-anchor="middle" class="d-tiny">outbound wss</text>
  <text x="277" y="168" text-anchor="middle" class="d-tiny">no port forwarding</text>
  <text x="623" y="168" text-anchor="middle" class="d-tiny">no static IP</text>

  <path d="M 110 78 C 110 30, 790 30, 790 78" fill="none" stroke="var(--ok)" stroke-width="2" stroke-dasharray="6 4" />
  <rect x="368" y="18" width="164" height="26" rx="13" fill="var(--bg)" stroke="var(--ok)" />
  <text x="450" y="36" text-anchor="middle" class="d-ok">end-to-end encrypted</text>

  <text x="450" y="252" text-anchor="middle" class="d-sub">Because both devices connect outward, the tunnel forms across any NAT.</text>
  <text x="450" y="274" text-anchor="middle" class="d-sub">The relay never holds a key, so it can only move sealed bytes.</text>
</svg>`

/** Noise IKpsk2 in two messages. */
export const handshake = () => `
<svg viewBox="0 0 900 400" role="img" aria-label="QR pairing followed by a two-message Noise IKpsk2 handshake">
  ${defs}
  <text x="150" y="26" text-anchor="middle" class="d-title">Desktop</text>
  <text x="750" y="26" text-anchor="middle" class="d-title">Phone</text>
  <line x1="150" y1="40" x2="150" y2="370" stroke="var(--line)" stroke-width="2" />
  <line x1="750" y1="40" x2="750" y2="370" stroke="var(--line)" stroke-width="2" />

  <rect x="30" y="52" width="240" height="52" rx="8" fill="var(--card)" stroke="var(--line)" />
  <text x="150" y="72" text-anchor="middle" class="d-sub">shows a QR carrying</text>
  <text x="150" y="92" text-anchor="middle" class="d-mono">relay URL · static pubkey · 32-byte secret</text>

  <line x1="270" y1="78" x2="628" y2="78" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#arrow-muted)" />
  <text x="450" y="68" text-anchor="middle" class="d-tiny">scanned by camera — out of band, so the relay can never sit in the middle</text>

  <rect x="600" y="112" width="290" height="46" rx="8" fill="var(--card)" stroke="var(--line)" />
  <text x="745" y="140" text-anchor="middle" class="d-mono">rid = HMAC(secret, "rid-v1")</text>
  <text x="450" y="180" text-anchor="middle" class="d-tiny">both sides derive the same 256-bit rendezvous ID — the only thing the relay learns</text>

  <line x1="740" y1="214" x2="162" y2="214" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="206" text-anchor="middle" class="d-mono">message 1: e, es, s, ss</text>
  <text x="450" y="232" text-anchor="middle" class="d-tiny">phone's identity travels encrypted; desktop learns and pins it</text>

  <line x1="160" y1="278" x2="738" y2="278" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="270" text-anchor="middle" class="d-mono">message 2: e, ee, se, psk</text>
  <text x="450" y="296" text-anchor="middle" class="d-tiny">the pairing secret is mixed in here — only the device that scanned can finish</text>

  <rect x="300" y="322" width="300" height="52" rx="8" fill="var(--card)" stroke="var(--ok)" />
  <text x="450" y="342" text-anchor="middle" class="d-ok">two transport keys, one per direction</text>
  <text x="450" y="362" text-anchor="middle" class="d-tiny">fresh every session — yesterday's traffic stays unreadable if a key leaks tomorrow</text>
</svg>`

/** Manifest, credit window, checkpoints, resume. */
export const fileFlow = () => `
<svg viewBox="0 0 900 380" role="img" aria-label="File transfer: manifest, want, windowed chunks, acks, resume after a dropout">
  ${defs}
  <text x="150" y="26" text-anchor="middle" class="d-title">Sender</text>
  <text x="750" y="26" text-anchor="middle" class="d-title">Receiver</text>
  <line x1="150" y1="40" x2="150" y2="352" stroke="var(--line)" stroke-width="2" />
  <line x1="750" y1="40" x2="750" y2="352" stroke="var(--line)" stroke-width="2" />

  <line x1="160" y1="70" x2="738" y2="70" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="62" text-anchor="middle" class="d-mono">MANIFEST — name, size, chunk size, count, sha256</text>

  <line x1="740" y1="108" x2="162" y2="108" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="100" text-anchor="middle" class="d-mono">WANT — "start from chunk N"</text>
  <text x="450" y="126" text-anchor="middle" class="d-tiny">N is 0 for a new file, or the last checkpoint for one already part-received</text>

  <line x1="160" y1="162" x2="738" y2="162" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <line x1="160" y1="180" x2="738" y2="180" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <line x1="160" y1="198" x2="738" y2="198" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="154" text-anchor="middle" class="d-mono">CHUNK × up to 32 in flight — 256 KiB each, sealed individually</text>
  <text x="450" y="222" text-anchor="middle" class="d-tiny">memory stays flat: the window is held, never the file</text>

  <line x1="740" y1="252" x2="162" y2="252" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="244" text-anchor="middle" class="d-mono">ACK every 16 chunks — releases credit and writes a checkpoint</text>

  <rect x="250" y="278" width="400" height="30" rx="8" fill="var(--card)" stroke="var(--bad)" stroke-dasharray="4 3" />
  <text x="450" y="298" text-anchor="middle" class="d-bad">phone loses signal — socket dies mid-flight</text>

  <line x1="740" y1="332" x2="162" y2="332" stroke="var(--accent)" stroke-width="2" marker-end="url(#arrow)" />
  <text x="450" y="324" text-anchor="middle" class="d-mono">reconnect → new handshake → WANT from the checkpoint</text>
  <text x="450" y="352" text-anchor="middle" class="d-tiny">the transfer continues; nothing already delivered is sent twice</text>
</svg>`

/** Where every piece of state lives — the ZDR claim as a picture. */
export const stateMap = () => `
<svg viewBox="0 0 900 260" role="img" aria-label="All durable state lives on the two devices; the relay holds only live sockets">
  ${defs}
  <rect x="20" y="60" width="230" height="150" rx="12" fill="var(--card)" stroke="var(--ok)" />
  <text x="135" y="88" text-anchor="middle" class="d-title">Desktop</text>
  <text x="135" y="112" text-anchor="middle" class="d-sub">keys in Keychain</text>
  <text x="135" y="134" text-anchor="middle" class="d-sub">conversations, files</text>
  <text x="135" y="156" text-anchor="middle" class="d-sub">sync cursors, outbox</text>
  <text x="135" y="186" text-anchor="middle" class="d-ok">durable</text>

  <rect x="335" y="60" width="230" height="150" rx="12" fill="var(--card)" stroke="var(--bad)" stroke-dasharray="4 3" />
  <text x="450" y="88" text-anchor="middle" class="d-title">Relay</text>
  <text x="450" y="112" text-anchor="middle" class="d-sub">two live sockets</text>
  <text x="450" y="134" text-anchor="middle" class="d-sub">a role tag per socket</text>
  <text x="450" y="156" text-anchor="middle" class="d-sub">nothing else, ever</text>
  <text x="450" y="186" text-anchor="middle" class="d-bad">amnesiac</text>

  <rect x="650" y="60" width="230" height="150" rx="12" fill="var(--card)" stroke="var(--ok)" />
  <text x="765" y="88" text-anchor="middle" class="d-title">Phone</text>
  <text x="765" y="112" text-anchor="middle" class="d-sub">keys in Keystore</text>
  <text x="765" y="134" text-anchor="middle" class="d-sub">mirrored data, file cache</text>
  <text x="765" y="156" text-anchor="middle" class="d-sub">resume checkpoints</text>
  <text x="765" y="186" text-anchor="middle" class="d-ok">durable</text>

  <text x="450" y="34" text-anchor="middle" class="d-sub">Unpairing deletes two keychain entries. There is nothing in the middle to delete.</text>
  <text x="450" y="240" text-anchor="middle" class="d-tiny">When the last socket closes the relay instance is evicted — and eviction is the whole cleanup.</text>
</svg>`
