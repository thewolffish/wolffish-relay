# wolffish-relay — Agent Guide

Zero-retention WebSocket relay for the Wolffish tunnel, plus a deliberately small push-notification control plane. One Cloudflare Worker + one Durable Object class. Desktop (`host`) and mobile (`guest`) meet at `wss://relay.wolffi.sh/t/<rid>` and exchange end-to-end-encrypted binary frames; the relay forwards them verbatim and retains nothing of them. Binary records tagged `0x03` are the exception by design: plaintext JSON control frames addressed to the relay itself (push registrations, notify requests, acks), parsed and terminated here so notifications can reach a phone that is not connected.

## Stack

- Cloudflare Workers + Durable Objects (WebSocket **Hibernation API** — connection state lives in socket tags/attachments, never in instance fields; the constructor re-runs after hibernation). The DO is keyed by `idFromName(rid)` — stable per PAIRING, which is what lets push registrations survive reconnects.
- TypeScript, no runtime dependencies. Tests run inside workerd via `@cloudflare/vitest-pool-workers`.
- One secret: `EXPO_ACCESS_TOKEN` (production: Worker secret; local: `.dev.vars`, gitignored). The Expo project has Enhanced Security for Push Notifications ON — an unauthenticated exp.host call fails every send.
- Deploys **only** from GitHub Actions on release tags (`npm run release`). See RELEASE.md.

## Project layout

```
src/
├── protocol.ts   the entire wire contract: rid regex, roles, close codes,
│                 1 MiB frame cap, keepalive strings, presence notices, and
│                 the push control plane (frame types, limits, validators)
├── tunnel.ts     the Tunnel DO — pairing, replacement, forwarding, enforcement,
│                 push routing (in-band + ack timeout + Expo fallback), receipt sweep
├── push.ts       Expo push API client — plain fetch, batched, loud on auth errors
├── index.ts      stateless front door: validation + route to DO by rid
└── types.ts      Env binding types
test/relay.test.ts  data-plane contract suite (front door, presence, relaying,
                    enforcement, replacement, isolation)
test/push.test.ts   control-plane suite (validation, authorization, idempotency,
                    ack-timeout fallback, receipt-driven token pruning)
test/helpers.ts     shared websocket test client
wrangler.jsonc      config — encodes the retention invariants; read its header comment
SETUP.md            one-time Cloudflare/GitHub setup + hardening checklist
```

## Invariants (violating any of these is a bug, not a style choice)

1. **The data plane is opaque and unretained.** Handshake (`0x01`) and transport (`0x02`) records are forwarded verbatim — never parsed past byte 0, transformed, buffered, stored, or logged. No storage bindings beyond the DO itself (no KV/D1/R2/queues/analytics), `observability.enabled` stays `false`, no message content in any log line, ever.
2. **The control plane is minimal and explicit.** Only `0x03` records are parsed. The DO persists exactly three record kinds — `device:<phoneId>`, `ticket:<notificationId>`, `notif:<notificationId>` — and never notification titles/bodies. Push tokens appear in logs only as a short prefix (`tokenPrefix`). The only external fetch in the codebase is `push.ts` → exp.host.
3. **Model-led only, desktop-stamped identity.** Notifications exist because the desktop's model called a tool; the relay adds no triggers of its own. `notify` is accepted only from the `host` socket, `register_push`/`notification_ack` only from `guest`, and a notify's `phoneId` must match a registration on this pairing — reject, never reroute.
4. **Hibernation-safe.** Never keep connection state in instance fields; derive everything from `ctx.getWebSockets(tag)` and socket attachments. (The `pendingAcks` map is the audited exception: it only spans the ~2 s ack window that `waitUntil` keeps the object alive for.)
5. **One socket per role**, newest wins; replacement must never surface as `peer-gone` to the counterpart.
6. **Text frames from clients still close the connection** (except the runtime-answered keepalive). The control plane is binary `0x03`, not text — old relays forward unknown binary records harmlessly, which is what keeps version skew from breaking tunnels.
7. Every contract change lands in `src/protocol.ts` + README's contract section + the test suite, in the same commit.

## Commands

`npm run dev` (needs `.dev.vars`) · `npm test` · `npm run typecheck` · `npm run lint` · `npm run format` · `npm run release`
