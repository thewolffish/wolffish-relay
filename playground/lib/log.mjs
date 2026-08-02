/** Run log: console output plus a structured record the HTML report renders. */

const COLORS = {
  desktop: '\x1b[36m', // cyan
  mobile: '\x1b[35m', // magenta
  relay: '\x1b[33m', // yellow
  test: '\x1b[32m', // green
  wire: '\x1b[90m', // grey
  fail: '\x1b[31m', // red
  reset: '\x1b[0m'
}

export function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function duration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

export function speed(byteCount, ms) {
  if (!ms) return '—'
  const mbps = byteCount / 1024 / 1024 / (ms / 1000)
  return `${mbps.toFixed(2)} MB/s (${((byteCount * 8) / 1e6 / (ms / 1000)).toFixed(0)} Mbps)`
}

export class RunLog {
  constructor() {
    this.startedAt = Date.now()
    this.lines = []
    this.phases = []
    this.checks = []
    this.transfers = []
    this.evidence = []
    this.current = null
  }

  line(actor, message) {
    const at = Date.now() - this.startedAt
    const stamp = `${(at / 1000).toFixed(2)}s`.padStart(8)
    const tag = `[${actor}]`.padEnd(10)
    const color = COLORS[actor] ?? ''
    console.log(`${COLORS.wire}${stamp}${COLORS.reset} ${color}${tag}${COLORS.reset} ${message}`)
    this.lines.push({ at, actor, message })
  }

  desktop = (m) => this.line('desktop', m)
  mobile = (m) => this.line('mobile', m)
  relay = (m) => this.line('relay', m)
  wire = (m) => this.line('wire', m)

  phase(title, detail = '') {
    if (this.current) this.endPhase()
    this.current = { title, detail, startedAt: Date.now(), checks: [] }
    console.log(`\n\x1b[1m▸ ${title}\x1b[0m${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`)
    return this.current
  }

  endPhase() {
    if (!this.current) return
    this.current.ms = Date.now() - this.current.startedAt
    this.phases.push(this.current)
    this.current = null
  }

  /** Record a pass/fail assertion. Failures never throw — the run continues so
   * one broken expectation cannot hide the rest of the report. */
  check(ok, label, detail = '') {
    const entry = { ok: Boolean(ok), label, detail, phase: this.current?.title ?? '—' }
    this.checks.push(entry)
    if (this.current) this.current.checks.push(entry)
    const mark = ok ? `${COLORS.test}✓${COLORS.reset}` : `${COLORS.fail}✗${COLORS.reset}`
    console.log(`  ${mark} ${label}${detail ? `  ${COLORS.wire}${detail}${COLORS.reset}` : ''}`)
    return entry.ok
  }

  transfer(record) {
    this.transfers.push(record)
  }

  /** Wire-level evidence the report renders verbatim (hex dumps, entropy, …). */
  exhibit(record) {
    this.evidence.push(record)
  }

  get passed() {
    return this.checks.filter((c) => c.ok).length
  }

  get failed() {
    return this.checks.filter((c) => !c.ok).length
  }

  get totalMs() {
    return Date.now() - this.startedAt
  }
}
