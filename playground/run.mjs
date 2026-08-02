#!/usr/bin/env node
/**
 * Drives one complete tunnel cycle against the live relay and leaves physical
 * evidence behind.
 *
 *   npm run playground           full run, including the 248 MB PDF
 *   npm run playground:quick     everything except the big file
 *   npm run playground -- --relay ws://localhost:8787   drive a local wrangler dev
 *
 * Output (all gitignored) lands in playground/out:
 *   desktop/   what the desktop had — the source of truth for this run
 *   mobile/    what actually arrived over the tunnel
 *   report.html · run.json · run.log
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunLog, bytes, duration } from './lib/log.mjs'
import { writeReport } from './lib/report.mjs'
import { phases } from './scenario.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_RELAY = 'wss://relay.wolffi.sh'

function parseArgs(argv) {
  const options = { quick: false, relay: process.env.RELAY_URL ?? DEFAULT_RELAY, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--quick') options.quick = true
    else if (argv[i] === '--keep') options.keep = true
    else if (argv[i] === '--relay') options.relay = argv[++i]
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const log = new RunLog()
  const outDir = path.join(here, 'out')
  const dirs = {
    out: outDir,
    cache: path.join(outDir, '.cache'),
    desktop: path.join(outDir, 'desktop'),
    desktopFiles: path.join(outDir, 'desktop', 'files'),
    mobile: path.join(outDir, 'mobile'),
    mobileFiles: path.join(outDir, 'mobile', 'files'),
    mobileOutbox: path.join(outDir, 'mobile', 'outbox'),
    parts: path.join(outDir, 'mobile', '.parts'),
    desktopInbox: path.join(outDir, 'desktop', 'inbox'),
    desktopParts: path.join(outDir, 'desktop', '.parts')
  }

  // A fresh run starts from clean folders, but the download cache survives.
  for (const dir of [dirs.desktop, dirs.mobile]) await fs.rm(dir, { recursive: true, force: true })
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })

  // Restore the guard that lives inside this directory. Deleting `out/` takes
  // it with them, and a 248 MB cached PDF is exactly the kind of thing that
  // then walks into a commit. (The root .gitignore covers this too — belt and
  // braces, because one of these is easy to delete by accident.)
  await fs.writeFile(
    path.join(outDir, '.gitignore'),
    '# Everything a run produces is disposable evidence — never committed.\n*\n!.gitignore\n'
  )

  console.log(`\n\x1b[1mWolffish tunnel — full cycle\x1b[0m`)
  console.log(
    `\x1b[90mrelay ${options.relay}${options.quick ? '  ·  quick run (no big file)' : ''}\x1b[0m`
  )

  const ctx = {
    options,
    dirs,
    log,
    relayUrl: options.relay,
    results: {},
    // The deploy-day DNS cache on this machine can still answer NXDOMAIN for the
    // relay hostname; pin the edge when the resolver refuses it.
    lookup: undefined
  }
  ctx.lookup = await resolveLookup(options.relay, log)

  let fatal = null
  for (const phase of phases) {
    if (phase.skip?.(ctx)) continue
    log.phase(phase.title, phase.detail)
    try {
      await phase.run(ctx)
    } catch (error) {
      fatal = error
      log.check(false, `phase "${phase.title}" crashed`, error.message)
      console.error(error)
      break
    }
  }
  log.endPhase()

  ctx.desktop?.close(1000, 'run complete')
  ctx.mobile?.close(1000, 'run complete')

  const reportPath = await writeReport({ log, ctx, outDir, repoRoot: path.join(here, '..') })

  const line = '─'.repeat(64)
  console.log(`\n${line}`)
  console.log(
    log.failed === 0
      ? `\x1b[32m\x1b[1m✓ ALL ${log.checks.length} CHECKS PASSED\x1b[0m`
      : `\x1b[31m\x1b[1m✗ ${log.failed} of ${log.checks.length} CHECKS FAILED\x1b[0m`
  )
  console.log(`${line}`)
  const totals = ctx.results.totals ?? {}
  console.log(`  files delivered   ${totals.files ?? 0} · ${bytes(totals.bytes ?? 0)}`)
  console.log(
    `  encrypted frames  ${(totals.frames ?? 0).toLocaleString()} · ${bytes(totals.wireBytes ?? 0)} on the wire`
  )
  if (ctx.results.bigFile) {
    console.log(
      `  big file          ${ctx.results.bigFile.name} · ${bytes(ctx.results.bigFile.size)} · ` +
        `${ctx.results.bigFile.speed} · resumed after dropout`
    )
  }
  console.log(`  wall clock        ${duration(log.totalMs)}`)
  console.log(`\n  report            ${reportPath}`)
  console.log(`  delivered files   ${dirs.mobileFiles}\n`)

  if (fatal || log.failed > 0) process.exit(1)
}

/**
 * Node's resolver is authoritative, but this machine cached an NXDOMAIN for
 * relay.wolffi.sh from before the record existed. Fall back to the edge IPs from
 * a direct DNS query so a stale local cache cannot fail the run.
 */
async function resolveLookup(relayUrl, log) {
  const host = new URL(relayUrl.replace(/^ws/, 'http')).hostname
  if (host === 'localhost' || host === '127.0.0.1') return undefined
  const dns = await import('node:dns/promises')
  try {
    await dns.lookup(host)
    return undefined
  } catch {
    const resolver = new dns.Resolver()
    resolver.setServers(['1.1.1.1', '8.8.8.8'])
    const addresses = await resolver.resolve4(host)
    log.relay(`system resolver has no record for ${host}; using ${addresses[0]} directly`)
    return (_hostname, _opts, cb) => cb(null, [{ address: addresses[0], family: 4 }])
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
