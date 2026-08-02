/**
 * Everything a run moves comes from the published demo dataset — the same
 * bytes the mobile app downloads in demo mode. Nothing is read from a local
 * workspace, so the run is identical on any machine that clones this repo and
 * carries no personal data.
 *
 *   cdn.wolffi.sh/demo      manifest.json → conversation shards + config snapshot
 *   cdn.wolffi.sh/samples   one file per type the desktop recognises (109 of them)
 *   cdn.wolffi.sh/generic   large assets — miller.pdf
 *
 * Downloads are cached in `playground/out/.cache/`, so the first run fetches and
 * later runs are offline-fast. The staged copies still land in the run's
 * desktop and phone folders, so transfers move real bytes out of real folders.
 */
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { bytes } from './log.mjs'

export const DEMO_BASE_URL = process.env.DEMO_BASE_URL ?? 'https://cdn.wolffi.sh/demo'
export const SAMPLES_BASE_URL = process.env.SAMPLES_BASE_URL ?? 'https://cdn.wolffi.sh/samples'
export const SAMPLE_STEM = 'wolffish-sample'
export const BIG_PDF_URL = 'https://cdn.wolffi.sh/generic/miller.pdf'

const exists = async (p) => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** Fetch-and-cache by URL; returns the cached path. */
async function cached(url, cacheDir, name, log) {
  await fs.mkdir(cacheDir, { recursive: true })
  const file = path.join(cacheDir, name)
  if (await exists(file)) return { file, fromCache: true }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`)
  await pipeline(response.body, createWriteStream(file))
  const { size } = await fs.stat(file)
  log?.desktop(`fetched ${url.replace(/^https:\/\//, '')} (${bytes(size)})`)
  return { file, fromCache: false }
}

async function cachedJson(url, cacheDir, name, log) {
  const { file } = await cached(url, cacheDir, name, log)
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/** The published dataset's manifest — the index everything else follows. */
export async function loadDemoManifest(cacheDir, log) {
  // Always revalidated: the manifest is what tells us whether the cache is stale.
  const response = await fetch(`${DEMO_BASE_URL}/manifest.json`)
  if (!response.ok) throw new Error(`demo manifest → HTTP ${response.status}`)
  const manifest = await response.json()
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  log?.desktop(
    `demo manifest ${manifest.version} — ${manifest.conversations} conversations, ` +
      `${manifest.shards.length} shards, ${bytes(manifest.totalBytes)} total`
  )
  return manifest
}

/** The demo config snapshot: what a phone's settings screen renders. */
export async function loadDemoConfig(manifest, cacheDir, log) {
  const name = `${manifest.version}-${manifest.config.file}`
  const config = await cachedJson(
    `${DEMO_BASE_URL}/${manifest.config.file}?v=${encodeURIComponent(manifest.version)}`,
    cacheDir,
    name,
    log
  )
  log?.desktop(
    `demo config — ${Object.keys(config).length} sections, ${bytes(manifest.config.bytes)}`
  )
  return config
}

/**
 * Conversations from the published shards. Shards are pulled newest-first until
 * the requested count is met, so a run costs one or two shards rather than the
 * whole 18 MB dataset.
 */
export async function loadDemoConversations(manifest, cacheDir, limit, log) {
  const collected = []
  // Later shards hold the smaller, more numerous conversations; start there so
  // one download covers a whole run.
  for (const shard of [...manifest.shards].reverse()) {
    const name = `${manifest.version}-${shard.file}`
    const payload = await cachedJson(
      `${DEMO_BASE_URL}/${shard.file}?v=${encodeURIComponent(manifest.version)}`,
      cacheDir,
      name,
      log
    )
    for (const conversation of payload.conversations ?? []) {
      if (!conversation?.id || !Array.isArray(conversation.messages)) continue
      collected.push({
        file: `${shard.file}#${conversation.id}`,
        bytes: JSON.stringify(conversation).length,
        conversation
      })
      if (collected.length >= limit) break
    }
    if (collected.length >= limit) break
  }
  collected.sort((a, b) => (b.conversation.updatedAt ?? 0) - (a.conversation.updatedAt ?? 0))
  log?.desktop(
    `loaded ${collected.length} demo conversations ` +
      `(${collected.reduce((n, c) => n + c.conversation.messages.length, 0)} messages)`
  )
  return collected
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
    channel: conversation.channel ?? null,
    bytes: size
  }))
}

/**
 * A deliberately awkward spread of published sample files — one per type, the
 * same bytes the demo serves for every `.pdf`, `.png`, `.gif` a conversation
 * references — plus generated edge cases the product will meet in the wild.
 */
export async function selectSampleFiles(desktopDir, cacheDir, log) {
  const wanted = ['png', 'md', 'json', 'html', 'pdf', 'gif', 'mp4', 'docx']
  const chosen = []

  for (const ext of wanted) {
    const fileName = `${SAMPLE_STEM}.${ext}`
    try {
      const { file } = await cached(`${SAMPLES_BASE_URL}/${fileName}`, cacheDir, fileName, log)
      const { size } = await fs.stat(file)
      await fs.copyFile(file, path.join(desktopDir, fileName))
      chosen.push({ name: fileName, size, source: `samples/${ext}` })
    } catch (error) {
      log?.desktop(`sample .${ext} unavailable — skipping (${error.message})`)
    }
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

  // Exactly one chunk + 1 byte: exercises the windowed-frame boundary.
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
 * Files the phone holds and the desktop does not — a camera capture and a voice
 * memo, standing in for everything only a device can produce.
 */
export async function selectMobileUploads(outboxDir, cacheDir, log) {
  await fs.mkdir(outboxDir, { recursive: true })
  const staged = []

  const captureName = 'camera-capture.jpg'
  try {
    const { file } = await cached(
      `${SAMPLES_BASE_URL}/${SAMPLE_STEM}.jpg`,
      cacheDir,
      `${SAMPLE_STEM}.jpg`,
      log
    )
    const { size } = await fs.stat(file)
    await fs.copyFile(file, path.join(outboxDir, captureName))
    staged.push({ name: captureName, size, source: 'phone camera roll' })
  } catch (error) {
    log?.mobile(`camera sample unavailable — ${error.message}`)
  }

  const memo = `# Voice memo — transcribed on device\n\nCaptured on the phone, never on the desktop.\nUploaded through the tunnel so the agent can act on it.\n`
  await fs.writeFile(path.join(outboxDir, 'voice-memo.md'), memo, 'utf8')
  staged.push({ name: 'voice-memo.md', size: Buffer.byteLength(memo), source: 'phone recording' })

  log?.mobile(
    `staged ${staged.length} files the phone alone has (${bytes(staged.reduce((n, f) => n + f.size, 0))})`
  )
  return staged
}

/** Puts miller.pdf in the desktop replica, cached after the first download. */
export async function stageBigPdf({ cacheDir, desktopDir, log }) {
  const { file, fromCache } = await cached(BIG_PDF_URL, cacheDir, 'miller.pdf', log)
  const destination = path.join(desktopDir, 'miller.pdf')
  await fs.copyFile(file, destination)
  const { size } = await fs.stat(destination)
  log?.desktop(`staged miller.pdf (${bytes(size)})${fromCache ? ' from the run cache' : ''}`)
  return {
    name: 'miller.pdf',
    size,
    source: BIG_PDF_URL.replace(/^https:\/\//, ''),
    path: destination
  }
}
