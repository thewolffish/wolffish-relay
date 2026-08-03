# playground — the full tunnel, driven end to end

A real drive of the live relay: it stands up both ends of the tunnel, pairs them
by QR, hand-shakes, and then moves real Wolffish data — configs, conversation
lists, conversation bodies, a live agent turn, and files up to 248 MB — while
proving that every byte crossing the relay is ciphertext.

**Every byte comes from the published demo dataset on `cdn.wolffi.sh`** — the
same manifest, conversation shards, config snapshot and sample files the mobile
app downloads in demo mode. Nothing is read from a local workspace, so the run
is identical on any machine that clones this repo and carries no personal data.

This is the harness the protocol package will be built against. The relay itself
is finished; this is how we keep it honest and how the client protocol gets
exercised before it goes anywhere near the desktop or mobile apps.

```bash
npm run playground          # full cycle, including the 248 MB PDF
npm run playground:quick    # everything except the big file (~1 min)
npm run playground:local    # drive `npm run dev` instead of production
```

## What one run does

| Phase                       | What it proves                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage from the demo dataset | The CDN manifest, conversation shards, config snapshot and per-type sample files are fetched and staged into a run-local folder that acts as the desktop's source of truth |
| Pair by QR code             | A scannable PNG is generated, "scanned", and both sides independently derive the same 256-bit rendezvous ID                                                                |
| Connect and hand-shake      | Noise IKpsk2 over the live relay: mutual authentication, key pinning, forward secrecy, matching transcript hashes                                                          |
| Prove the wire is opaque    | Live captured frames contain no plaintext markers and are high-entropy; flipped bits and wrong keys are rejected; the right key round-trips                                |
| Resist intruders            | A socket on another rendezvous ID hears nothing; an impostor who knows the rendezvous ID but never scanned the QR cannot complete the handshake or forge a frame           |
| Sync configuration          | The desktop's real `config.json` arrives section-complete, with credentials redacted **before** they leave the desktop                                                     |
| Sync conversations          | Index first, then full bodies on demand — compared byte for byte against the originals                                                                                     |
| Run a live conversation     | A real agent turn streams back as deltas and tool events, reassembled exactly on the phone                                                                                 |
| Reverse direction           | The phone serves the desktop: it advertises its own tools, the desktop invokes one, and the phone uploads files the desktop never had                                      |
| Move files                  | Real workspace files plus deliberate edge cases: a zero-byte file, an Arabic (RTL) filename, and a payload one byte past the chunk boundary                                |
| Move the 248 MB PDF         | `miller.pdf` transfers while the phone is forcibly disconnected mid-flight, then resumes from its checkpoint and verifies sha256 end to end                                |
| Verify delivery             | Every file on both sides is hashed and compared; no partial files may remain                                                                                               |

## What a run leaves behind

**[`../RELAY.html`](../RELAY.html)** — the committed reference document, regenerated with this run's real figures. It is the relay's public explainer: architecture, security model, retention guarantees, the example run, and the self-hosting guide. Edit its prose in `lib/report.mjs`, then `npm run report` to re-render without re-running the cycle.

Everything else lands in `playground/out/` (gitignored):

```
out/
├── desktop/            the desktop's side of this run
│   ├── files/          what it had to send — real bytes, staged from ~/.wolffish
│   ├── pairing-qr.png  the actual QR a phone could scan
│   └── pairing-payload.txt
├── mobile/             what genuinely arrived over the tunnel
│   ├── files/          including miller.pdf — open it, it's a working PDF
│   ├── conversations/  full bodies, byte-identical to the desktop's
│   ├── config.json
│   └── live-turn.md    the streamed agent reply, reassembled
├── run.json            machine-readable results (feeds RELAY.html)
└── run.log             the full timeline
```

Open [`../RELAY.html`](../RELAY.html) to see the run rather than read it —
including the desktop → relay → phone journey of the big PDF with its
throughput, the hexdump of what the relay actually carried, and the sha256
comparison table.

## Extending it

`scenario.mjs` exports an ordered array of phases:

```js
{
  title: 'Something new',
  detail: 'shown in the report',
  skip: (ctx) => ctx.options.quick,   // optional
  async run(ctx) {
    const answer = await ctx.mobile.rpc('system.check')
    ctx.log.check(answer.ok, 'the thing works')
  }
}
```

Append an entry and it appears in the console output, the HTML report, and the
pass/fail total. `ctx` carries both tunnels (`ctx.desktop`, `ctx.mobile`), the
staged fixtures, the output directories, and the logger.

New RPC methods or events go in `lib/devices.mjs`; new fixtures in
`lib/fixtures.mjs`.

## How it is put together

| File                | Role                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `run.mjs`           | Entry point: prepares folders, runs phases, writes the report                                                                  |
| `scenario.mjs`      | The ordered cycle — the part you extend                                                                                        |
| `lib/noise.mjs`     | Noise IKpsk2 (`Noise_IKpsk2_25519_ChaChaPoly_SHA256`) via `@noble`, pure JS so the same code runs on Node, Electron and Hermes |
| `lib/tunnel.mjs`    | A tunnel endpoint: frames, RPC, events, the resumable file engine, and the wiretap                                             |
| `lib/devices.mjs`   | How each side behaves — desktop serves, mobile receives                                                                        |
| `lib/fixtures.mjs`  | Real data selection from `~/.wolffish`, the mobile demo set, and the CDN                                                       |
| `lib/report.mjs`    | The reference document (`RELAY.html`) plus the JSON and log output                                                             |
| `lib/diagrams.mjs`  | Inline SVG illustrations used by the document                                                                                  |
| `render-report.mjs` | `npm run report` — re-render the document from the last run                                                                    |

## Notes

- **Nothing is mocked.** Frames cross the real `relay.wolffi.sh` Worker. Turning
  the relay off makes this run fail, which is the point.
- **Both ends run on one machine**, so throughput figures share a single uplink —
  read them as a floor, not a ceiling. Small files are latency-bound (two round
  trips of protocol before the first byte), large files are bandwidth-bound.
- **Downloads are cached** in `out/.cache/`, keyed by the manifest version. The
  first run fetches ~250 MB (mostly `miller.pdf`); later runs are offline-fast.
  Point `DEMO_BASE_URL` / `SAMPLES_BASE_URL` at a staging bundle to test one.
- **Credentials never leave the desktop side.** Config sync redacts any
  token/key/secret-shaped field before transmission — a phone has no use for the
  desktop's API keys. The demo dataset is already anonymised, so this is a
  belt-and-braces pass that the run asserts is working.
