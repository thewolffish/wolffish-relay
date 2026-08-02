/**
 * Real Wolffish data for the run — nothing synthetic.
 *
 * Sources, in the order the product itself would use them:
 *   ~/.wolffish/workspace          the live desktop runtime: config, conversations, files
 *   wolffish-mobile/demo-data      the curated demo set the app ships against
 *   cdn.wolffi.sh                  large assets fetched on demand (miller.pdf)
 *
 * Everything selected here is copied into the run's gitignored desktop replica
 * first, so the transfer moves real bytes out of a real folder.
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { bytes } from './log.mjs'

export const WORKSPACE = path.join(os.homedir(), '.wolffish', 'workspace')
export const MOBILE_DEMO = path.join(
  os.homedir(),
  'Documents',
  'wolffish',
  'wolffish-mobile',
  'demo-data'
)
export const BIG_PDF_URL = 'https://cdn.wolffi.sh/generic/miller.pdf'
export const BIG_PDF_LOCAL = path.join(os.homedir(), 'Documents', 'miller.pdf')

const exists = async (p) => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** The desktop's real config.json, plus the mobile-shaped snapshot. */
export async function loadConfigs() {
  const desktopConfig = JSON.parse(await fs.readFile(path.join(WORKSPACE, 'config.json'), 'utf8'))
  let snapshot = null
  const snapshotPath = path.join(MOBILE_DEMO, 'config-snapshot.json')
  if (await exists(snapshotPath)) snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'))
  return { desktopConfig, snapshot }
}

/**
 * Newest real conversations from the desktop brain. Returns the index rows the
 * desktop would advertise plus the full payloads it serves on request.
 */
export async function loadConversations(limit = 12) {
  const dir = path.join(WORKSPACE, 'brain', 'conversations')
  const names = await fs.readdir(dir)
  const withTimes = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => ({ n, mtime: (await fs.stat(path.join(dir, n))).mtimeMs }))
  )
  withTimes.sort((a, b) => b.mtime - a.mtime)

  const conversations = []
  for (const { n } of withTimes.slice(0, limit)) {
    try {
      const raw = await fs.readFile(path.join(dir, n), 'utf8')
      const conversation = JSON.parse(raw)
      if (!conversation.id || !Array.isArray(conversation.messages)) continue
      conversations.push({ file: n, bytes: raw.length, conversation })
    } catch {
      /* skip anything unreadable — the run should not depend on one bad file */
    }
  }
  return conversations
}

/** Index rows: what a "sync the conversation list" call actually returns. */
export function toIndexRows(conversations) {
  return conversations.map(({ conversation, bytes: size }) => ({
    id: conversation.id,
    title: conversation.title,
    model: conversation.model || null,
    messages: conversation.messages.length,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    icon: conversation.icon ?? null,
    bytes: size
  }))
}

/**
 * A deliberately awkward spread of real files: tiny, text, image, animation,
 * document — plus generated edge cases (empty file, Arabic filename) that the
 * product will meet in the wild.
 */
export async function selectFiles(desktopDir, log) {
  const filesDir = path.join(WORKSPACE, 'files')
  const chosen = []

  const all = await fs.readdir(filesDir)
  const stats = await Promise.all(
    all.map(async (name) => {
      try {
        const s = await fs.stat(path.join(filesDir, name))
        return s.isFile() ? { name, size: s.size } : null
      } catch {
        return null
      }
    })
  )
  const usable = stats.filter(Boolean).filter((f) => !f.name.startsWith('.'))
  const byExt = (ext, { min = 0, max = Infinity } = {}) =>
    usable
      .filter((f) => f.name.toLowerCase().endsWith(ext) && f.size >= min && f.size <= max)
      .sort((a, b) => a.size - b.size)

  const picks = [
    byExt('.png', { min: 1 })[0], // smallest real png — often a 9-byte stub
    byExt('.md')[0],
    byExt('.json')[0],
    byExt('.html', { min: 20_000 })[0],
    byExt('.pdf', { min: 500_000, max: 4_000_000 }).at(-1), // a chunky real PDF
    byExt('.gif', { min: 2_000_000, max: 12_000_000 })[0] // multi-chunk binary
  ].filter(Boolean)

  for (const pick of picks) {
    const from = path.join(filesDir, pick.name)
    const to = path.join(desktopDir, pick.name)
    await fs.copyFile(from, to)
    chosen.push({ name: pick.name, size: pick.size, source: 'workspace/files' })
  }

  // Edge cases the real world will produce sooner or later.
  const emptyName = 'empty-marker.txt'
  await fs.writeFile(path.join(desktopDir, emptyName), '')
  chosen.push({ name: emptyName, size: 0, source: 'generated (zero-byte edge case)' })

  const arabicName = 'تقرير-المزامنة-٢٠٢٦.txt'
  const arabicBody = `تقرير المزامنة\nالمصدر: سطح المكتب\nالوجهة: الهاتف\nالحالة: مشفّر من طرف إلى طرف\n`
  await fs.writeFile(path.join(desktopDir, arabicName), arabicBody, 'utf8')
  chosen.push({
    name: arabicName,
    size: Buffer.byteLength(arabicBody),
    source: 'generated (RTL filename edge case)'
  })

  // Exactly one chunk + 1 byte: exercises the boundary between windowed frames.
  const boundaryName = 'chunk-boundary.bin'
  const boundary = Buffer.alloc(256 * 1024 + 1, 0xab)
  await fs.writeFile(path.join(desktopDir, boundaryName), boundary)
  chosen.push({
    name: boundaryName,
    size: boundary.length,
    source: 'generated (chunk-boundary edge case)'
  })

  log?.desktop(
    `staged ${chosen.length} files into the desktop replica ` +
      `(${bytes(chosen.reduce((n, f) => n + f.size, 0))})`
  )
  return chosen
}

/**
 * Puts miller.pdf in the desktop replica. Prefers a cached copy, then the local
 * Documents copy, and downloads from the CDN when neither exists — the download
 * path is what a fresh clone of this repo will take.
 */
export async function stageBigPdf({ cacheDir, desktopDir, log }) {
  await fs.mkdir(cacheDir, { recursive: true })
  const cached = path.join(cacheDir, 'miller.pdf')
  const destination = path.join(desktopDir, 'miller.pdf')
  let origin

  if (await exists(cached)) {
    origin = 'run cache'
  } else if (await exists(BIG_PDF_LOCAL)) {
    log?.desktop('seeding miller.pdf from ~/Documents (skips a 248 MB download)')
    await fs.copyFile(BIG_PDF_LOCAL, cached)
    origin = '~/Documents/miller.pdf'
  } else {
    log?.desktop(`downloading ${BIG_PDF_URL} …`)
    const started = Date.now()
    const response = await fetch(BIG_PDF_URL)
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
    await pipeline(response.body, createWriteStream(cached))
    const size = (await fs.stat(cached)).size
    log?.desktop(`downloaded ${bytes(size)} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    origin = BIG_PDF_URL
  }

  await fs.copyFile(cached, destination)
  const { size } = await fs.stat(destination)
  log?.desktop(`staged miller.pdf (${bytes(size)}) from ${origin}`)
  return { name: 'miller.pdf', size, source: origin, path: destination }
}
