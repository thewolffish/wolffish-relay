<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-relay

**A meeting point that forgets you exist.**

The zero-retention rendezvous relay for the Wolffish tunnel. A single Cloudflare Worker with one Durable Object class introduces a desktop and a phone by rendezvous ID and forwards their end-to-end-encrypted frames verbatim. It stores nothing, logs nothing, and only ever sees ciphertext.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.13-green.svg)](https://wolffi.sh)
[![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-lightgrey.svg)](<>)

> 📄 **[Illustrated reference →](https://cdn.wolffi.sh/generic/relay.html)** — the same material with diagrams, the ciphertext audit, throughput tables and a verified example run. Generated from a real run by `npm run playground`; its source is [RELAY.html](RELAY.html) in this repo.

---

## Contents

- [The problem it solves](#the-problem-it-solves)
- [How it works](#how-it-works)
- [How it's built](#how-its-built)
- [The wire contract](#the-wire-contract)
- [Moving data and files](#moving-data-and-files)
- [Security promises](#security-promises)
- [Zero data retention](#zero-data-retention)
- [No logs, no telemetry](#no-logs-no-telemetry)
- [Verifying it yourself](#verifying-it-yourself)
- [Run your own relay](#run-your-own-relay)
- [Development](#development)
- [Deployment](#deployment)

---

## The problem it solves

Two devices need to talk. Your desktop sits behind a home router; your phone sits behind a mobile carrier's NAT. Neither can accept an incoming connection, so neither can reach the other directly.

The usual answers are worse than they look. Port forwarding asks users to reconfigure routers. A traditional server means your data lives on someone else's disk. A sync service means an account, a database, and a breach waiting to happen.

This relay takes a different route: **both devices dial outward to the same address and meet there**, and everything that makes the tunnel safe happens on the devices before a byte is handed over. The relay is deliberately untrusted — it cannot read what it carries, and it keeps nothing once the sockets close.

## How it works

```
   Desktop (host)                                        Phone (guest)
   behind home NAT                                    behind carrier NAT
        |                                                      |
        |  outbound wss                          outbound wss  |
        +--------------->   relay.wolffi.sh   <----------------+
                           Worker + Durable Object
                           one instance per rendezvous ID
                           RAM only · no disk · no logs
        +---------------  end-to-end encrypted  ---------------+
                    the relay carries bytes it cannot read
```

Because both sides connect outward, the tunnel forms across any NAT with no port forwarding, no static IP, and no router configuration.

### Pairing happens once, by QR

The desktop shows a QR code carrying three things: the relay URL, its long-lived public key, and a freshly generated 32-byte pairing secret. The phone's camera reads it.

That camera hop is the security-critical part. Because the secret travels **out of band** — screen to lens, never over the network — a hostile relay cannot insert itself into the pairing. It never sees the secret, so it can never complete the handshake in the middle.

From that secret both devices independently derive the same rendezvous ID:

```
rid = HMAC(pairing_secret, "rid-v1")      # 256 bits, lowercase hex
```

It is unguessable, and it is the only fact about a pairing the relay ever learns. It identifies a meeting, not a person.

### Then a handshake, on every connection

Pairing is once; connecting is automatic and needs no user action. The devices already hold each other's keys, so they run a **Noise IKpsk2** handshake — the pattern built for exactly this asymmetry, where the initiator knows the responder's static key but not the reverse.

```
Noise_IKpsk2_25519_ChaChaPoly_SHA256

  <- s                        desktop's static key, carried by the QR
  ...
  -> e, es, s, ss             message 1   phone -> desktop
  <- e, ee, se, psk           message 2   desktop -> phone
                              => two transport keys, one per direction
```

| Property                  | What it means                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Mutual authentication** | Each side proves possession of its long-term key; the desktop pins the phone's key on first contact        |
| **Forward secrecy**       | Fresh ephemeral keys per session — a key stolen next year cannot decrypt traffic captured today            |
| **Pairing binding**       | The pairing secret enters as the PSK, so knowing the rendezvous ID is _not_ enough to complete a handshake |

One round trip, typically ~600 ms including the connection.

### Connection lifecycle

The two sides behave differently, and deliberately so.

The **desktop parks**: one long-lived connection held open with a 25-second keepalive, which the Workers runtime answers without even waking the Durable Object. The **phone comes and goes**: iOS suspends the app on background, so it connects when it becomes active and disappears when it doesn't.

Neither is a problem, because reconnection is stateless and cheap. A returning device runs a fresh handshake — new session keys, no user action, sub-second — and any interrupted file transfer resumes from its checkpoint. Desktop clients should reconnect with exponential backoff and treat disconnection as routine weather rather than an error state.

## How it's built

The entire cloud footprint is one Worker script containing one Durable Object class — about 250 lines. No server, no container, no database, nothing to patch.

| File                                 | Role                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| [`src/index.ts`](src/index.ts)       | Stateless front door: validates the URL shape and role, routes to the Durable Object owning that rendezvous ID     |
| [`src/tunnel.ts`](src/tunnel.ts)     | The Durable Object: pairs the two roles, forwards binary frames verbatim, replaces zombie sockets, enforces limits |
| [`src/protocol.ts`](src/protocol.ts) | The wire contract in one file — ID format, roles, frame cap, keepalive, close codes, presence notices              |
| [`wrangler.jsonc`](wrangler.jsonc)   | Configuration, and where the retention guarantees are pinned so every deploy re-asserts them                       |

### Why a Durable Object

A plain Worker is stateless by design: two requests can land on two machines in two cities that share nothing. If both devices simply "connected to the Worker" they would land on unrelated instances and never find each other.

A Durable Object adds exactly one thing: **named single-instance routing**. Every request for a given name reaches the same one running instance, anywhere on earth. That is what lets two sockets be in the same place at the same time.

"Durable" refers to that stable _identity_, not to storage. A Durable Object _may_ attach persistent storage; this one simply never calls it.

The relay uses the WebSocket **Hibernation API**, so an idle tunnel is evicted from memory entirely and a parked desktop costs nothing. Connection state lives inside the sockets themselves (role tags and attachments), never in instance fields — and eviction is the whole cleanup story.

## The wire contract

### Endpoints

| Route                                               | Behaviour                                     |
| --------------------------------------------------- | --------------------------------------------- |
| `GET /t/<rid>?role=host\|guest` + WebSocket upgrade | Join the tunnel for that rendezvous ID        |
| `GET /healthz`                                      | `200 ok`                                      |
| `GET /`                                             | Status page (HEAD allowed, for uptime checks) |
| anything else                                       | `404` / `400` / `405` / `426`                 |

`rid` must match `^[0-9a-f]{64}$`. The desktop connects as **`host`** — the parked, always-on side. The phone connects as **`guest`**.

### Frames

- **Binary frames are peer data**: opaque sealed records, forwarded verbatim to the other role, capped at **1 MiB** each.
- **Text frames from the relay** are presence notices, the only text it ever sends: `{"t":"peer-present"}` and `{"t":"peer-gone"}`.
- **Text from a client**: exactly one is legal — the keepalive `ping` -> `pong`, answered by the runtime without waking the Durable Object. Send it every ~25 s to hold idle connections open. Anything else closes the connection.

### Close codes

| Code   | Name              | Meaning                                                           |
| ------ | ----------------- | ----------------------------------------------------------------- |
| `4000` | Replaced          | A newer connection for your role arrived; this socket was evicted |
| `4400` | ProtocolViolation | You sent a non-keepalive text frame                               |
| `4413` | MessageTooLarge   | You sent a frame over 1 MiB                                       |

### Semantics client authors must know

- **One live socket per role.** A reconnect _replaces_ its predecessor, and the peer never sees a false `peer-gone` during that swap.
- **Frames sent while the peer is absent are dropped.** Presence notices tell you when someone is there; delivery guarantees belong to the end-to-end protocol's acknowledgements, never to the relay.
- **The relay never buffers, parses, or persists frames.** There is no queue, no history, no storage.

## Moving data and files

Above the sealed frame layer sit three kinds of traffic, all multiplexed on one socket:

- **RPC** — request/response in either direction. The phone fetches configs and conversations; the desktop calls tools only the phone has (camera, location, notifications).
- **Events** — unsolicited pushes: streaming agent output, "this conversation changed".
- **Files** — resumable transfer, either direction.

**The tunnel is fully symmetric once established.** Which side dialed out first stops mattering after the handshake; both ends serve and consume.

Files never move as files. They move as a stream of independently sealed chunks:

```
sender                                                    receiver
  |  MANIFEST  name, size, chunk size, count, sha256          |
  |---------------------------------------------------------->|
  |                             WANT  "start from chunk N"     |
  |<----------------------------------------------------------|
  |  CHUNK x up to 32 in flight, 256 KiB each, sealed alone    |
  |---------------------------------------------------------->|
  |            ACK every 16 chunks — credit + checkpoint       |
  |<----------------------------------------------------------|
  |             ** connection dies mid-transfer **             |
  |  reconnect -> new handshake -> WANT from the checkpoint    |
  |---------------------------------------------------------->|
```

Each chunk is encrypted on its own, so a corrupted or reordered one fails loudly and alone rather than poisoning the file. The receiver writes each chunk straight to disk at its offset and checkpoints every sixteen; if the connection dies, reconnecting replays the manifest and the receiver asks to continue where it stopped. When the last chunk lands, the whole-file hash is compared against the manifest before the file becomes visible.

The sender holds a window, never the file, so memory stays flat whether the file is 3 MB or 300 GB. There is no protocol size limit — the practical bounds are disk space and patience.

## Security promises

The relay is **untrusted by design**. Every guarantee below holds even if the relay is fully compromised, operated by someone else, or replaced by a hostile clone.

| Promise                                    | How it's achieved                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Content is unreadable in transit           | Every frame sealed on-device with ChaCha20-Poly1305 under keys the relay never sees           |
| Tampering is detected                      | AEAD authentication per frame — one flipped bit fails the tag and the frame is discarded      |
| Replay and reordering fail                 | Per-session keys with a strictly increasing nonce counter                                     |
| Past traffic stays safe                    | Forward secrecy — fresh ephemeral keys per session                                            |
| The relay cannot impersonate either device | Mutual authentication against pinned static keys; the pairing secret it never saw is required |
| Pairing cannot be intercepted              | The secret travels out of band, screen to camera, and is mixed in as the PSK                  |
| Strangers cannot join                      | The rendezvous ID is 256 bits; even holding it does not permit a handshake                    |
| Nothing survives the session               | No storage is ever written — see below                                                        |

### What a hostile relay could still do

Stated plainly, because a security claim without its limits is marketing.

A relay operator — Cloudflare, or you if you self-host — can observe **while the sockets are live**: the two IP addresses, the rendezvous ID, the timing of frames, and their sizes. It can also refuse service or drop frames.

It **cannot** read content, alter it undetected, replay it, forge a frame either device will accept, impersonate either side, or recover anything after disconnection. Traffic metadata is the irreducible cost of any relayed system; this design keeps it minimal and never records it.

## Zero data retention

"We don't store your data" is a promise. Here is the version you can check — every piece of state in the system and where it lives.

| State                                            | Where it lives                                 | Lifetime                                         |
| ------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| Device keypairs, peer public key, pairing secret | Platform secure storage — see the caveat below | Until you unpair                                 |
| Conversations, configs, files, sync cursors      | Each app's own local database                  | The product's own data — endpoints, not the pipe |
| Session keys                                     | Both devices' RAM                              | One connection                                   |
| The socket pair and a role tag                   | Relay RAM                                      | Dies with the sockets                            |
| Any database, object store, queue or log         | **Does not exist**                             | —                                                |

Unpairing means deleting the stored key material on each device. There is nothing in the cloud to delete because nothing was ever written there — which is also why reconnection is free: there is no server-side session to restore, ever.

**Measured, not asserted.** After a full playground run moved ~249 MB through production, the relay's storage meters read **0 B** across every counter — SQL storage, key-value storage, rows read, rows written, storage operations. Compute happened; storage did not.

### Where the keys actually live

"Secure storage" is not one thing, and the guarantee differs per platform. What each side actually gets:

| Platform | Backend                                                         | What it protects against                                         |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| macOS    | Keychain, via Electron `safeStorage`                            | Other users **and** other apps in the same user session          |
| iOS      | Keychain Services, via `expo-secure-store`                      | Other apps; survives app uninstall under the same bundle ID      |
| Android  | Keystore-encrypted `SharedPreferences`, via `expo-secure-store` | Other apps; cleared on uninstall                                 |
| Windows  | DPAPI, via Electron `safeStorage`                               | Other **users** on the machine — _not_ other apps running as you |
| Linux    | `gnome-libsecret` / `kwallet`, via Electron `safeStorage`       | Other users, **only when a secret store is present**             |

**The approach is deliberately boring: use each platform's default.** `safeStorage` on desktop and `expo-secure-store` on mobile are built in, need no native modules, and behave the same on every install — no passphrase prompts, no custom key derivation, nothing that can fail for a subset of users.

One documented gap comes with that choice. On Linux, if no secret store is available, Electron's docs say items "will be unprotected as they are encrypted via hardcoded plaintext password" — obfuscation rather than encryption, on headless boxes and minimal window managers.

That is accepted rather than engineered around. A device whose home directory an attacker can already read has bigger problems than these keys, and the alternatives all trade a rare edge case for complexity that would fail for ordinary users. `safeStorage.getSelectedStorageBackend()` returns the active backend in one call, so the connection-details screen can simply show it.

## No logs, no telemetry

Retention has a second face: even without a database, a service can leak everything through its logs. This one is configured so there is nothing to leak, and the settings live in version control so every deploy re-asserts them.

| Surface                                                 | State                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Worker logs and traces                                  | Disabled in `wrangler.jsonc` (`observability.enabled = false`) |
| Log export (Logpush)                                    | No jobs configured                                             |
| `console.log` anywhere in the source                    | Not a single one                                               |
| Error-tracking or analytics SDK                         | None — the Worker has no runtime dependencies                  |
| Storage bindings (KV, D1, R2, queues, analytics engine) | None — the only binding is the Durable Object itself           |
| Build-tool telemetry                                    | Off (`send_metrics: false`)                                    |
| Browser telemetry headers (NEL / report-to)             | Switched off at the zone                                       |
| Tail workers (a covert log path)                        | None connected                                                 |

What remains, honestly: the platform's own aggregate request counters, and TLS terminating at the edge as it does for any hosted service. Neither exposes content, because what crosses the edge is already ciphertext sealed on your devices. If that residual matters to you, the answer is [running the relay yourself](#run-your-own-relay).

## Verifying it yourself

Two layers of proof ship with the repo.

**`npm test`** — 19 contract tests inside real workerd: routing, role validation, pairing and presence, verbatim binary relay, cross-rendezvous isolation, text-frame and oversize enforcement, and socket-replacement semantics.

**`npm run playground`** — the whole system driven end to end against the live relay. It stands up both ends of the tunnel, pairs by QR, hand-shakes, audits the wire, tries to break in, syncs configs and conversations, streams an agent turn, moves files in both directions including a 248 MB PDF that is deliberately interrupted mid-flight, and verifies every artifact by sha256.

Every fixture comes from the published demo dataset on `cdn.wolffi.sh` — the same manifest, conversation shards, config snapshot and per-type sample files the mobile app downloads in demo mode. Nothing is read from a local workspace, so a clone of this repo produces an identical run on any machine.

A full run is **55 checks** and regenerates [RELAY.html](RELAY.html). See [playground/README.md](playground/README.md) for the phase list and how to extend it.

## Run your own relay

The desktop and mobile apps let you point at any relay, because the relay URL travels inside the pairing QR. Change it there and the devices meet at your address instead — no other setting, no rebuild. Content security never depended on the relay's honesty, so swapping in your own costs nothing.

### Option A — your own Cloudflare deployment

```bash
git clone https://github.com/thewolffish/wolffish-relay.git
cd wolffish-relay && npm install

# point it at your hostname: edit wrangler.jsonc ->
#   "routes": [{ "pattern": "relay.example.com", "custom_domain": true }]
# or delete "routes" and set "workers_dev": true

npx wrangler login
npx wrangler deploy
curl https://relay.example.com/healthz     # -> ok
```

To keep the retention guarantees, leave these exactly as they ship: `observability.enabled: false`, `send_metrics: false`, no storage bindings, and no Logpush job on the zone. Deploying from CI instead of a laptop needs only two secrets — a scoped API token and your account ID; see [SETUP.md](SETUP.md).

### Option B — anywhere that runs Node

Nothing about the relay is Cloudflare-specific: it matches two sockets by name and forwards bytes. This is the whole thing.

```js
import { WebSocketServer } from 'ws' // npm i ws

const rooms = new Map() // rid -> { host, guest }   RAM only, never persisted
const RID = /^[0-9a-f]{64}$/
const MAX = 1024 * 1024

new WebSocketServer({ port: 8787 }).on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const rid = url.pathname.match(/^\/t\/([0-9a-f]{64})$/)?.[1]
  const role = url.searchParams.get('role')
  if (!rid || !RID.test(rid) || (role !== 'host' && role !== 'guest')) return ws.close(1008)

  const room = rooms.get(rid) ?? {}
  room[role]?.close(4000, 'replaced') // newest connection per role wins
  room[role] = ws
  rooms.set(rid, room)

  const peer = () => (role === 'host' ? room.guest : room.host)
  if (peer()?.readyState === 1) {
    ws.send('{"t":"peer-present"}')
    peer().send('{"t":"peer-present"}')
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return data.toString() === 'ping' ? ws.send('pong') : ws.close(4400)
    if (data.length > MAX) return ws.close(4413)
    if (peer()?.readyState === 1) peer().send(data, { binary: true })
  })

  ws.on('close', () => {
    if (room[role] === ws) delete room[role]
    if (peer()?.readyState === 1) peer().send('{"t":"peer-gone"}')
    if (!room.host && !room.guest) rooms.delete(rid) // forget everything
  })
})
```

Serve it over TLS (`wss://`), and **turn off access logging deliberately** — most web servers record every connection by default, which would put back exactly what this design removes. Make sure your proxy does not buffer or time out WebSocket upgrades.

### Verifying your relay

```bash
curl https://relay.example.com/healthz

# drive the entire cycle against your own deployment
npm run playground -- --relay wss://relay.example.com
```

That last command runs pairing, handshake, ciphertext audit, intrusion probes, bidirectional transfer with an interruption, and byte-for-byte verification against your relay — and writes you a report like the hosted one.

## Development

| Command                                 | What it does                                                  |
| --------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                           | Local relay on `localhost:8787` via `wrangler dev`            |
| `npm test`                              | Contract suite in workerd (`@cloudflare/vitest-pool-workers`) |
| `npm run playground`                    | Drive the whole tunnel end to end against the live relay      |
| `npm run playground:quick`              | Same, without the 248 MB file (~1 min)                        |
| `npm run playground:local`              | Drive `npm run dev` instead of production                     |
| `npm run report`                        | Re-render `RELAY.html` from the last run's data               |
| `npm run typecheck` / `lint` / `format` | The usual guards                                              |
| `npm run release`                       | Version bump + tag push -> CI deploys to Cloudflare           |

Requirements: Node 24+, npm 11+.

## Deployment

Releases are cut with `npm run release` and deployed **exclusively by GitHub Actions** — a tag push runs the full verification suite, and only a green run reaches Cloudflare. No credentials live on a laptop.

See [RELEASE.md](RELEASE.md) for the procedure and [SETUP.md](SETUP.md) for the one-time Cloudflare + GitHub setup, including the hardening checklist.

## License

[MIT](LICENSE) © Younes Alturkey
