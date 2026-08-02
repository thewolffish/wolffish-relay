/** Renders the run as a self-contained HTML page next to the delivered files. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { bytes, duration } from './log.mjs'

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )

export async function writeReport({ log, ctx, outDir }) {
  const ok = log.failed === 0
  const totals = ctx.results.totals ?? {}
  const evidence = log.evidence.find((e) => e.kind === 'wire')

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Wolffish tunnel — run report</title>
<style>
  :root{--bg:#0a0f1b;--fg:#e8edf5;--muted:#93a1b8;--line:rgba(147,161,184,.18);--card:rgba(147,161,184,.06);
        --ok:#34d399;--bad:#f87171;--accent:#6ea8fe}
  @media (prefers-color-scheme: light){:root{--bg:#f7f9fc;--fg:#141b26;--muted:#5a6b82;--line:rgba(20,27,38,.12);
        --card:rgba(20,27,38,.04);--ok:#059669;--bad:#dc2626;--accent:#2563eb}}
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:2.5rem 1.25rem}
  main{max-width:60rem;margin:0 auto}
  h1{font-size:1.6rem;letter-spacing:-.02em}h2{font-size:.78rem;text-transform:uppercase;letter-spacing:.12em;
     color:var(--muted);margin:2.5rem 0 .9rem}
  .sub{color:var(--muted);margin-top:.25rem;font-size:.92rem}
  .badge{display:inline-block;padding:.3rem .8rem;border-radius:999px;font-weight:650;font-size:.85rem}
  .pass{background:rgba(52,211,153,.15);color:var(--ok)}.fail{background:rgba(248,113,113,.15);color:var(--bad)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.75rem;margin-top:1.25rem}
  .card{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:.9rem 1rem}
  .card .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .card .v{font-size:1.25rem;font-weight:650;margin-top:.2rem}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
  pre{padding:1rem;overflow-x:auto;white-space:pre;color:var(--muted)}
  .ok{color:var(--ok)}.bad{color:var(--bad)}
  .flow{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;border:1px solid var(--line);background:var(--card);
        border-radius:14px;padding:1.1rem 1.25rem;margin-top:.5rem}
  .flow .node{flex:1;min-width:12rem}.flow .node .t{font-weight:650}.flow .node .p{color:var(--muted);font-size:.8rem;
        word-break:break-all}
  .arrow{color:var(--accent);font-weight:650;text-align:center;font-size:.82rem;min-width:9rem}
  .qr{max-width:190px;border-radius:10px;border:1px solid var(--line)}
  .lead{display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-start;margin-top:1.5rem}
  ul{margin:.4rem 0 0 1.1rem;color:var(--muted);font-size:.88rem}
</style></head><body><main>

<h1>Wolffish tunnel — end-to-end run</h1>
<p class="sub">${esc(ctx.relayUrl)} · rendezvous <code>${esc(ctx.rid?.slice(0, 24))}…</code> · ${esc(new Date(log.startedAt).toISOString())}</p>
<p style="margin-top:1rem"><span class="badge ${ok ? 'pass' : 'fail'}">${ok ? 'ALL CHECKS PASSED' : `${log.failed} CHECK${log.failed === 1 ? '' : 'S'} FAILED`}</span></p>

<div class="cards">
  <div class="card"><div class="k">Checks</div><div class="v">${log.passed}/${log.checks.length}</div></div>
  <div class="card"><div class="k">Files delivered</div><div class="v">${totals.files ?? 0}</div></div>
  <div class="card"><div class="k">Payload moved</div><div class="v">${bytes(totals.bytes ?? 0)}</div></div>
  <div class="card"><div class="k">Encrypted frames</div><div class="v">${(totals.frames ?? 0).toLocaleString()}</div></div>
  <div class="card"><div class="k">Wall clock</div><div class="v">${duration(log.totalMs)}</div></div>
  <div class="card"><div class="k">Handshake</div><div class="v">${ctx.handshakeMs ?? '—'} ms</div></div>
</div>

<div class="lead">
  ${ctx.qr ? `<div><h2 style="margin-top:0">Pairing QR</h2><img class="qr" src="../desktop/pairing-qr.png" alt="pairing QR" /></div>` : ''}
  <div style="flex:1;min-width:18rem">
    <h2 style="margin-top:0">What this run proved</h2>
    <ul>
      <li>Pairing by QR, both sides deriving the same rendezvous ID</li>
      <li>Noise IKpsk2 handshake with mutual key pinning and forward secrecy</li>
      <li>Every byte on the wire opaque to the relay — verified against live captures</li>
      <li>Real config, conversation list, conversation bodies and a live agent turn</li>
      <li>Files from 0 bytes to ${bytes(ctx.results.bigFile?.size ?? 0)}, interrupted and resumed</li>
    </ul>
  </div>
</div>

${
  ctx.results.bigFile
    ? `<h2>The big one: ${esc(ctx.results.bigFile.name)}</h2>
<div class="flow">
  <div class="node"><div class="t">Desktop replica</div><div class="p">out/desktop/files/${esc(ctx.results.bigFile.name)}</div>
    <div class="p">${bytes(ctx.results.bigFile.size)} · from ${esc(ctx.results.bigFile.source)}</div></div>
  <div class="arrow">── encrypted ──▶<br />${esc(ctx.results.bigFile.speed)}<br />${duration(ctx.results.bigFile.ms)} · resumed @ chunk ${ctx.results.bigFile.resumedFrom ?? 0}</div>
  <div class="node"><div class="t">Phone</div><div class="p">out/mobile/files/${esc(ctx.results.bigFile.name)}</div>
    <div class="p ${ctx.results.bigFile.ok ? 'ok' : 'bad'}">${ctx.results.bigFile.ok ? 'sha256 verified identical' : 'MISMATCH'}</div></div>
</div>`
    : ''
}

<h2>Transfers</h2>
<div class="wrap"><table><thead><tr><th>File</th><th>Origin</th><th class="num">Size</th><th class="num">Time</th><th class="num">Throughput</th><th>Result</th></tr></thead><tbody>
${log.transfers
  .map(
    (
      t
    ) => `<tr><td><code>${esc(t.name)}</code></td><td style="color:var(--muted)">${esc(t.source ?? '')}</td>
      <td class="num">${bytes(t.size)}</td><td class="num">${duration(t.ms)}</td><td class="num">${esc(t.speed)}</td>
      <td class="${t.ok ? 'ok' : 'bad'}">${t.ok ? 'delivered' : 'failed'}${t.interrupted ? ' · resumed' : ''}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>

<h2>Phases</h2>
<div class="wrap"><table><thead><tr><th>Phase</th><th>Detail</th><th class="num">Checks</th><th class="num">Time</th></tr></thead><tbody>
${log.phases
  .map(
    (p) => `<tr><td>${esc(p.title)}</td><td style="color:var(--muted)">${esc(p.detail)}</td>
      <td class="num ${p.checks.every((c) => c.ok) ? 'ok' : 'bad'}">${p.checks.filter((c) => c.ok).length}/${p.checks.length}</td>
      <td class="num">${duration(p.ms ?? 0)}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>

<h2>Checks</h2>
<div class="wrap"><table><thead><tr><th></th><th>Assertion</th><th>Detail</th><th>Phase</th></tr></thead><tbody>
${log.checks
  .map(
    (c) => `<tr><td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}</td><td>${esc(c.label)}</td>
      <td style="color:var(--muted)">${esc(c.detail)}</td><td style="color:var(--muted)">${esc(c.phase)}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>

${
  evidence
    ? `<h2>Ciphertext, exactly as the relay sees it</h2>
<p class="sub">${evidence.frames.toLocaleString()} frames · ${bytes(evidence.bytes)} · Shannon entropy ${evidence.entropy.toFixed(2)} bits/byte (8.0 = indistinguishable from random)</p>
<div class="wrap"><pre>${evidence.samples
        .map(
          (s) =>
            `${s.direction.padEnd(14)} ${String(s.bytes).padStart(7)} B  ${s.context.padEnd(14)} ${s.head}…`
        )
        .join('\n')}</pre></div>`
    : ''
}

<h2>Byte-for-byte verification</h2>
<div class="wrap"><table><thead><tr><th>File</th><th class="num">Size</th><th>sha256 (desktop = phone)</th><th></th></tr></thead><tbody>
${(ctx.results.comparisons ?? [])
  .map(
    (c) => `<tr><td><code>${esc(c.name)}</code></td><td class="num">${bytes(c.size ?? 0)}</td>
      <td><code style="color:var(--muted)">${esc((c.sha256 ?? c.note ?? '').slice(0, 32))}…</code></td>
      <td class="${c.ok ? 'ok' : 'bad'}">${c.ok ? 'identical' : 'MISMATCH'}</td></tr>`
  )
  .join('\n')}
</tbody></table></div>

<h2>Run log</h2>
<div class="wrap"><pre>${log.lines
    .map(
      (l) =>
        `${(l.at / 1000).toFixed(2).padStart(8)}s  ${`[${l.actor}]`.padEnd(10)} ${esc(l.message)}`
    )
    .join('\n')}</pre></div>

<p class="sub" style="margin-top:2.5rem">Generated by <code>npm run playground</code> — wolffish-relay</p>
</main></body></html>`

  const file = path.join(outDir, 'report.html')
  await fs.writeFile(file, html)
  await fs.writeFile(
    path.join(outDir, 'run.json'),
    JSON.stringify(
      {
        startedAt: log.startedAt,
        totalMs: log.totalMs,
        relayUrl: ctx.relayUrl,
        rid: ctx.rid,
        passed: log.passed,
        failed: log.failed,
        phases: log.phases.map((p) => ({ title: p.title, ms: p.ms, checks: p.checks })),
        transfers: log.transfers,
        results: ctx.results
      },
      null,
      2
    )
  )
  await fs.writeFile(
    path.join(outDir, 'run.log'),
    log.lines.map((l) => `${(l.at / 1000).toFixed(2)}s [${l.actor}] ${l.message}`).join('\n')
  )
  return file
}
