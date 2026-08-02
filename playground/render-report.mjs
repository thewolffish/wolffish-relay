#!/usr/bin/env node
/**
 * Re-renders `report.html` from the last run's `playground/out/run.json`.
 *
 * Useful when editing the document itself — the prose, diagrams or self-hosting
 * guide — without spending five minutes re-running the full cycle. The figures
 * still come from a real run.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderReference } from './lib/report.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const runPath = path.join(here, 'out', 'run.json')

let run
try {
  run = JSON.parse(await fs.readFile(runPath, 'utf8'))
} catch {
  console.error(`No run data at ${runPath} — run \`npm run playground\` first.`)
  process.exit(1)
}

const target = path.join(here, '..', 'report.html')
await fs.writeFile(target, renderReference(run))
console.log(
  `report.html rendered from the run of ${run.generatedAt ?? new Date(run.startedAt).toISOString()}`
)
console.log(`  ${target}`)
