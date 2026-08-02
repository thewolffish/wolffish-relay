# SETUP.md — One-time Cloudflare + GitHub setup

Everything needed to take this repo from source code to a live, hardened `wss://relay.wolffi.sh`, deploying only from GitHub Actions. Steps are in order; each is done once. Nothing here is ever deployed from a laptop.

---

## 0. Prerequisites

- The `wolffi.sh` zone active in your Cloudflare account (it already serves `cdn.wolffi.sh`).
- A Cloudflare plan that includes Durable Objects. The relay uses a **SQLite-backed DO class** (`new_sqlite_classes` in wrangler.jsonc), which is the variant available on the free plan; on Workers Paid everything here works unchanged. If the first deploy errors on DO availability, enable Durable Objects once in the dashboard (**Workers & Pages → Durable Objects**) or upgrade the plan.
- Node 24+ locally (for running tests before pushing — never for deploying).

## 1. Create the GitHub repository

On GitHub, create **`thewolffish/wolffish-relay`** (public — this repo is open source). Then from this directory:

```bash
git remote add origin git@github.com:thewolffish/wolffish-relay.git
git push -u origin main
```

The push triggers the **CI** workflow (typecheck, lint, tests, `wrangler deploy --dry-run` config validation). No deploy happens on pushes — only on release tags.

## 2. Mint the Cloudflare API token

Dashboard → profile icon → **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, then scope it down:

- **Account Resources:** include → your account only.
- **Zone Resources:** include → specific zone → `wolffi.sh`.
- Leave the template's permissions as-is (Workers Scripts: Edit, Workers Routes: Edit, plus the template's account-level Workers permissions).
- **Add one permission:** `Zone → DNS → Edit` for `wolffi.sh` — the custom domain `relay.wolffi.sh` is created by the deploy itself, which needs to write the DNS record and provision the certificate. (If you'd rather not grant DNS:Edit permanently, grant it for the first deploy and remove it after the custom domain exists.)
- TTL: no expiry, or renew on a calendar you'll actually keep.

Copy the token once — it's shown a single time.

Also note your **Account ID**: Dashboard → Workers & Pages → overview, right-hand column.

## 3. Configure GitHub secrets and the Production environment

Repo → **Settings → Environments → New environment** → name it exactly `Production` (the release workflow targets it). Optional but recommended: add yourself as a required reviewer, so a tag push pauses for one click before touching Cloudflare.

Then **Settings → Secrets and variables → Actions** (or add them as environment secrets on `Production`):

| Secret                  | Value                 |
| ----------------------- | --------------------- |
| `CLOUDFLARE_API_TOKEN`  | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your account ID       |

Nothing else. There are no other credentials in this system — by design there is nothing else to leak.

## 4. Power on: cut the first release

```bash
npm run release
```

That runs `npm version patch && git push origin main --tags` → the **Release** workflow verifies (typecheck, lint, full test suite), then deploys with `wrangler deploy`, then publishes a GitHub Release with generated notes and source archives.

The first deploy creates the Worker, runs the DO migration, and provisions the **custom domain `relay.wolffi.sh`** — DNS record plus edge certificate, automatically. Certificate issuance can take a few minutes; the workflow may finish before the hostname resolves.

Verify it's up:

```bash
curl https://relay.wolffi.sh/healthz
```

Expect `ok`.

## 5. Hardening + ZDR checklist (dashboard pass, ~5 minutes)

The config already encodes the invariants (`observability: false`, no storage bindings, no workers.dev, no preview URLs). This pass confirms the dashboard agrees and closes the zone-level gaps. Dash paths current as of 2026-08 — names drift; the _setting_ is what matters.

| #   | Where                                                              | Setting                                                                                                         | State                                                                                                                                                                |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Workers & Pages → wolffish-relay → **Observability**               | Workers Logs / Traces                                                                                           | **Disabled** (matches config — if the dash shows it on, the config was edited; fix the config, not the dash)                                                         |
| 2   | Workers & Pages → wolffish-relay → Settings → **Bindings**         | Bindings list                                                                                                   | **Exactly one:** the `TUNNEL` Durable Object. Anything else is a ZDR violation                                                                                       |
| 3   | Workers & Pages → wolffish-relay → Settings → **Domains & Routes** | Hostnames                                                                                                       | **Only** `relay.wolffi.sh`; no `workers.dev`, no preview URLs                                                                                                        |
| 4   | Account → Analytics → **Logs (Logpush)**                           | Jobs covering Workers or the zone                                                                               | **None configured**                                                                                                                                                  |
| 5   | wolffi.sh zone → **Security → WAF → Rate limiting rules**          | New rule: expression `(http.host eq "relay.wolffi.sh")`, rate ~`30` requests / `1 min` per IP, action **Block** | **On** — connection-storm brake. WebSocket upgrades are single requests, so 30/min/IP is generous for two devices reconnecting; long-lived sockets aren't re-counted |
| 6   | wolffi.sh zone → **Security → Bots**                               | Bot Fight Mode                                                                                                  | **Off** for this zone, or add a WAF **skip** rule for `relay.wolffi.sh` — bot challenges break native (non-browser) WebSocket clients                                |
| 7   | wolffi.sh zone → **Security → Settings**                           | Challenge behavior for `relay.wolffi.sh`                                                                        | No managed challenge on this hostname (same reason as #6). If the zone runs strict security, add a skip rule scoped to the hostname                                  |
| 8   | wolffi.sh zone → **SSL/TLS**                                       | Minimum TLS version                                                                                             | **1.2+** (1.3 preferred). The Worker has no origin server, so origin-side SSL modes don't apply to this hostname                                                     |

**What you cannot switch off, stated plainly:** Cloudflare's own transient edge analytics (request counts per zone) and TLS termination at their edge. Neither exposes content — every relayed frame is end-to-end ciphertext — and nothing configurable retains anything. That is the honest boundary of ZDR on managed infrastructure; the provable-by-source alternative is self-hosting the same ~250 lines, which this design deliberately keeps possible.

## 6. Smoke test the live relay

Presence + enforcement, with `wscat` (`npm i -g wscat`), using any 64-char lowercase-hex rid:

```bash
wscat -c "wss://relay.wolffi.sh/t/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?role=host"
```

```bash
wscat -c "wss://relay.wolffi.sh/t/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?role=guest"
```

Expected: the moment the second connects, **both** terminals print `{"t":"peer-present"}`. Type `ping` in either → `pong` comes back. Type anything else → that connection closes with code `4400` — which is the text-frame enforcement working, since wscat can only send text. Close the guest → the host prints `{"t":"peer-gone"}` and stays connected.

Binary relaying end-to-end (the real data path), from any machine with Node:

```bash
node --input-type=module -e '
const rid = "ab".repeat(32)
const host = new WebSocket(`wss://relay.wolffi.sh/t/${rid}?role=host`)
host.binaryType = "arraybuffer"
host.onmessage = (e) => {
  if (typeof e.data === "string") return console.log("host notice:", e.data)
  console.log("host received bytes:", new Uint8Array(e.data).join(","))
  process.exit(0)
}
host.onopen = () => {
  const guest = new WebSocket(`wss://relay.wolffi.sh/t/${rid}?role=guest`)
  guest.onopen = () => guest.send(new Uint8Array([1, 2, 3, 255]))
}
'
```

Expected final line: `host received bytes: 1,2,3,255`.

## 7. What just went live

- `wss://relay.wolffi.sh` — validated front door, one DO per rendezvous ID, at most one `host` + one `guest` socket each, binary frames forwarded verbatim with a 1 MiB cap, keepalives answered without waking the DO, zero retention everywhere.
- Deploys happen **only** via release tags through the `Production` environment. The laptop never holds deploy credentials.
- Next layer up: the tunnel protocol package (pairing QR, Noise IKpsk2 handshake, RPC/file frames) — a separate deliverable that talks _through_ this relay and needs nothing further from Cloudflare.
