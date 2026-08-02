# wolffish-relay — Agent Guide

Zero-retention WebSocket relay for the Wolffish tunnel. One Cloudflare Worker + one Durable Object class. Desktop (`host`) and mobile (`guest`) meet at `wss://relay.wolffi.sh/t/<rid>` and exchange end-to-end-encrypted binary frames; the relay forwards them verbatim and retains nothing.

## Stack

- Cloudflare Workers + Durable Objects (WebSocket **Hibernation API** — state lives in socket tags/attachments, never in instance fields; the constructor re-runs after hibernation).
- TypeScript, no runtime dependencies. Tests run inside workerd via `@cloudflare/vitest-pool-workers`.
- Deploys **only** from GitHub Actions on release tags (`npm run release`). See RELEASE.md.

## Project layout

```
src/
├── protocol.ts   the entire wire contract: rid regex, roles, close codes,
│                 1 MiB frame cap, keepalive strings, presence notices
├── tunnel.ts     the Tunnel DO — pairing, replacement, forwarding, enforcement
├── index.ts      stateless front door: validation + route to DO by rid
└── types.ts      Env binding types
test/relay.test.ts  full contract suite (front door, presence, relaying,
                    enforcement, replacement, isolation)
wrangler.jsonc      config — encodes the ZDR invariants; read its header comment
SETUP.md            one-time Cloudflare/GitHub setup + hardening checklist
```

## Invariants (violating any of these is a bug, not a style choice)

1. **Zero retention.** No storage API calls, no storage bindings (KV/D1/R2/queues/analytics), no logging (`console.*` included), no external fetches, `observability.enabled` stays `false`. The relay's only memory is the live sockets themselves.
2. **Frames are opaque.** Binary frames are forwarded verbatim — never parsed, transformed, buffered, or inspected. Text frames from clients (other than the runtime-answered `ping`) close the connection.
3. **Hibernation-safe.** Never keep connection state in instance fields; derive everything from `ctx.getWebSockets(tag)` and socket attachments.
4. **One socket per role**, newest wins; replacement must never surface as `peer-gone` to the counterpart.
5. Every contract change lands in `src/protocol.ts` + README's contract section + the test suite, in the same commit.

## Commands

`npm run dev` · `npm test` · `npm run typecheck` · `npm run lint` · `npm run format` · `npm run release`
