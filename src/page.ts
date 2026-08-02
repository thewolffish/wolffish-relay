/**
 * The landing page served at `GET /` — the only human-facing surface of the
 * relay. Fully static, zero JavaScript, styled inline; the only external
 * requests are two images from the Wolffish CDN (enforced by the CSP set in
 * index.ts). The "Online" status needs no script: if the relay were down,
 * this page would not have loaded.
 */
export function landingPage(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="description" content="Zero-retention rendezvous relay for the Wolffish tunnel. End-to-end encrypted, nothing stored, nothing logged." />
<title>wolffish relay</title>
<link rel="icon" type="image/png" href="https://cdn.wolffi.sh/generic/icon.png" />
<style>
  :root {
    --bg: #0a0f1b;
    --glow: rgba(59, 102, 166, 0.16);
    --fg: #e8edf5;
    --muted: #93a1b8;
    --line: rgba(147, 161, 184, 0.18);
    --card: rgba(147, 161, 184, 0.06);
    --green: #34d399;
    --green-bg: rgba(52, 211, 153, 0.12);
    --btn-bg: #ffffff;
    --btn-fg: #0a0f1b;
    --shadow: rgba(0, 0, 0, 0.55);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f9fc;
      --glow: rgba(59, 102, 166, 0.1);
      --fg: #141b26;
      --muted: #5a6b82;
      --line: rgba(20, 27, 38, 0.12);
      --card: rgba(20, 27, 38, 0.04);
      --green: #059669;
      --green-bg: rgba(5, 150, 105, 0.1);
      --btn-bg: #ffffff;
      --btn-fg: #141b26;
      --shadow: rgba(20, 27, 38, 0.18);
    }
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    min-height: 100svh;
    display: grid;
    background: var(--bg);
    background-image: radial-gradient(600px 420px at 50% 10%, var(--glow), transparent 70%);
    color: var(--fg);
    font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 3rem 1.25rem;
  }
  main { width: 100%; max-width: 33rem; margin: auto; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .logo {
    width: 88px; height: 88px; border-radius: 50%; object-fit: cover;
    box-shadow: 0 0 0 1px var(--line), 0 18px 48px -12px var(--shadow);
  }
  h1 { margin-top: 1.35rem; font-size: 1.7rem; font-weight: 650; letter-spacing: -0.02em; }
  h1 span { font-weight: 400; color: var(--muted); }
  .tagline { margin-top: 0.3rem; color: var(--muted); font-size: 0.98rem; }
  .meta { display: flex; gap: 0.5rem; margin-top: 1.15rem; }
  .pill {
    display: inline-flex; align-items: center; gap: 0.45rem;
    padding: 0.32rem 0.8rem; border-radius: 999px;
    font-size: 0.82rem; font-weight: 550;
    border: 1px solid var(--line); color: var(--muted); background: var(--card);
  }
  .pill.status { color: var(--green); border-color: transparent; background: var(--green-bg); }
  .dot { position: relative; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--green); }
  .dot::after {
    content: ''; position: absolute; inset: -4px; border-radius: 50%;
    border: 2px solid var(--green); animation: ping 2.4s ease-out infinite;
  }
  @keyframes ping {
    0% { transform: scale(0.35); opacity: 0.8; }
    70%, 100% { transform: scale(1.1); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) { .dot::after { animation: none; display: none; } }
  .endpoint {
    margin-top: 1.15rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem; color: var(--muted);
    background: var(--card); border: 1px solid var(--line);
    border-radius: 8px; padding: 0.45rem 0.75rem;
    max-width: 100%; overflow-x: auto; white-space: nowrap;
  }
  .how {
    margin-top: 2.1rem; width: 100%; text-align: left;
    border: 1px solid var(--line); background: var(--card);
    border-radius: 16px; padding: 1.4rem 1.5rem;
  }
  .how h2 {
    font-size: 0.76rem; font-weight: 600; letter-spacing: 0.12em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 0.85rem;
  }
  .how p { font-size: 0.94rem; color: var(--muted); }
  .how p + p { margin-top: 0.85rem; }
  .how strong { color: var(--fg); font-weight: 600; }
  .gh {
    display: inline-flex; align-items: center; gap: 0.6rem;
    margin-top: 1.9rem; padding: 0.68rem 1.15rem; border-radius: 12px;
    background: var(--btn-bg); color: var(--btn-fg);
    text-decoration: none; font-weight: 600; font-size: 0.92rem;
    border: 1px solid var(--line);
    transition: transform 0.12s ease, box-shadow 0.12s ease;
  }
  .gh:hover { transform: translateY(-1px); box-shadow: 0 10px 30px -10px var(--shadow); }
  .gh img { width: 20px; height: 20px; display: block; }
  footer { margin-top: 2.2rem; font-size: 0.82rem; color: var(--muted); }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <img class="logo" src="https://cdn.wolffi.sh/generic/icon.png" alt="Wolffish" width="88" height="88" />
  <h1>wolffish <span>relay</span></h1>
  <p class="tagline">A meeting point that forgets you exist.</p>
  <div class="meta">
    <span class="pill status"><span class="dot"></span>Online</span>
    <span class="pill">v${version}</span>
  </div>
  <code class="endpoint">wss://relay.wolffi.sh/t/&lt;rendezvous-id&gt;</code>
  <section class="how">
    <h2>How it works</h2>
    <p><strong>Meet.</strong> A desktop and a mobile device both dial out and meet here under an unguessable 256-bit rendezvous ID — no accounts, no port forwarding, at most two sockets per tunnel.</p>
    <p><strong>Move.</strong> Every frame is sealed end-to-end on the devices before it arrives. The relay forwards ciphertext verbatim — it cannot read, alter, or replay anything.</p>
    <p><strong>Forget.</strong> Zero retention by construction: no storage, no logs, no analytics. When the sockets close, nothing remains anywhere.</p>
  </section>
  <a class="gh" href="https://github.com/thewolffish/wolffish-relay">
    <img src="https://cdn.wolffi.sh/generic/github.png" alt="" width="20" height="20" />
    <span>thewolffish/wolffish-relay</span>
  </a>
  <footer>MIT · <a href="https://wolffi.sh">wolffi.sh</a></footer>
</main>
</body>
</html>
`
}
