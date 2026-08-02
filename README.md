<picture>
  <img src="https://cdn.wolffi.sh/generic/banner.jpg" alt="wolffish" />
</picture>

# wolffish-relay

**A meeting point that forgets you exist.**

The zero-retention rendezvous relay for the Wolffish tunnel — a single Cloudflare Worker with one Durable Object class that introduces a desktop (`host`) and a mobile device (`guest`) by rendezvous ID and forwards their end-to-end-encrypted frames verbatim. It stores nothing, logs nothing, and only ever sees ciphertext.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.2-green.svg)](https://wolffi.sh)
[![Platform](https://img.shields.io/badge/platform-Cloudflare%20Workers-lightgrey.svg)](<>)

---

## How it works

```
desktop (host) ──wss──▶ relay.wolffi.sh ◀──wss── mobile (guest)
                            │
                   Worker: validates /t/<rid>?role=…
                            │
                   Tunnel DO (one per rid, RAM only):
                   pairs the two roles, forwards binary
                   frames verbatim, answers keepalives
```

Both devices dial **out** to `wss://relay.wolffi.sh/t/<rid>?role=host|guest`, so the tunnel forms across any NAT with no port forwarding. The rendezvous ID (`rid`) is a 64-char lowercase-hex value derived by the clients from their pairing secret — unguessable, meaningless to the relay, and the only thing the relay ever learns about a pairing.

Every data frame is sealed by the clients (Noise-pattern handshake, per-session keys) **before** it reaches the relay. A fully compromised relay can observe connection metadata while sockets are live; it can never read, alter, or replay content, and when the sockets close nothing remains anywhere.

## The contract

### Endpoints

| Route                                               | Behavior                      |
| --------------------------------------------------- | ----------------------------- |
| `GET /t/<rid>?role=host\|guest` + WebSocket upgrade | Join the tunnel for `rid`     |
| `GET /healthz`                                      | `200 ok`                      |
| `GET /`                                             | One-line project pointer      |
| anything else                                       | `404` / `400` / `405` / `426` |

`rid` must match `^[0-9a-f]{64}$`. `host` is the parked, always-on side (desktop); `guest` comes and goes (mobile).

### Frames

- **Binary frames** are peer data: opaque encrypted records, forwarded verbatim to the other role. Max **1 MiB** per frame (`MessageTooLarge` close beyond it).
- **Text frames from the relay** are presence notices, the only text it ever sends: `{"t":"peer-present"}` and `{"t":"peer-gone"}`.
- **Text frames from a client**: exactly one is legal — the transport keepalive `ping`, answered `pong` by the Workers runtime without waking the Durable Object. Any other text frame closes the connection (`ProtocolViolation`). Send the keepalive every ~25 s to hold idle connections open.

### Close codes

| Code   | Name              | Meaning                                                           |
| ------ | ----------------- | ----------------------------------------------------------------- |
| `4000` | Replaced          | A newer connection for your role arrived; this socket was evicted |
| `4400` | ProtocolViolation | You sent a non-keepalive text frame                               |
| `4413` | MessageTooLarge   | You sent a frame over 1 MiB                                       |

### Semantics

- One live socket per role; a reconnect for the same role **replaces** its predecessor seamlessly (the peer never sees `peer-gone` during a replacement).
- Frames sent while the peer is absent are **dropped** — presence notices tell you when the peer is there; delivery guarantees belong to the end-to-end protocol's acks, not the relay.
- The relay never buffers, parses, or persists frames. There is no queue, no history, no storage.

## Zero data retention, by construction

- **No storage:** the Durable Object never touches its storage API; the only binding is the DO itself. No KV, no D1, no R2, no queues, no analytics engine.
- **No logs:** `observability.enabled = false` in [wrangler.jsonc](wrangler.jsonc); no Logpush; no error-tracking SDK; not a single `console.log` in the source.
- **No accounts:** the rid is a capability, not an identity. There is no user database because there are no users to record.
- **Hibernation-native:** all connection state lives inside the WebSockets themselves (tags + attachments). An idle tunnel is evicted from memory; a closed tunnel simply ceases to exist.

Residual trust, stated honestly: Cloudflare terminates TLS at its edge and keeps its own transient zone-level metrics; what is inside every frame remains ciphertext sealed on your devices. See [SETUP.md](SETUP.md) for the dashboard settings that keep everything configurable switched off.

## Development

| Command                                                 | What it does                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                                           | Local relay on `localhost:8787` via `wrangler dev`                 |
| `npm test`                                              | Full contract suite in workerd (`@cloudflare/vitest-pool-workers`) |
| `npm run typecheck` / `npm run lint` / `npm run format` | The usual guards                                                   |
| `npm run release`                                       | Version bump + tag push → CI deploys to Cloudflare                 |

Requirements: Node 24+, npm 11+.

## Deployment

Releases are cut with `npm run release` and deployed exclusively by GitHub Actions — see [RELEASE.md](RELEASE.md) for the procedure and [SETUP.md](SETUP.md) for the one-time Cloudflare + GitHub setup, including the ZDR hardening checklist.

## License

[MIT](LICENSE) © Younes Alturkey
