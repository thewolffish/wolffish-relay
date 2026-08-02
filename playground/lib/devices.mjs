/**
 * The two ends of the tunnel, behaving the way the real apps will.
 *
 * Desktop (host) is the source of truth: it parks on the relay and answers for
 * config, conversation lists, conversation bodies, agent runs, and files.
 * Mobile (guest) dials in, asks for what it needs, and writes every delivered
 * artifact to its own folder so the run leaves physical proof.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { bytes } from './log.mjs'

const SECRET_KEY = /(token|key|secret|password|apiKey|accessToken|refreshToken|session)/i

/**
 * Projects the desktop's config into what a phone actually needs. Credentials
 * are replaced before they ever leave the desktop — the phone has no use for
 * the desktop's API keys, and a sync should not clone secrets onto a second
 * device. Structure and size stay realistic.
 */
export function redactSecrets(value, counter = { count: 0 }) {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, counter))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof inner === 'string' && inner.length > 0) {
        counter.count += 1
        out[key] = `«redacted:${inner.length}»`
      } else {
        out[key] = redactSecrets(inner, counter)
      }
    }
    return out
  }
  return value
}

export function createDesktop({ tunnel, log, fixtures, desktopDir }) {
  const { conversations, indexRows, desktopConfig, snapshot } = fixtures

  tunnel.onRpc('config.get', async () => {
    const counter = { count: 0 }
    const safe = redactSecrets(desktopConfig, counter)
    log.desktop(`serving config.json (${counter.count} credential fields redacted before send)`)
    return { config: safe, snapshot: snapshot ? { keys: Object.keys(snapshot) } : null }
  })

  tunnel.onRpc('conversations.list', async ({ since = 0 } = {}) => {
    const rows = indexRows.filter((r) => (r.updatedAt ?? 0) > since)
    log.desktop(`serving conversation index — ${rows.length} rows`)
    return { rows, total: indexRows.length }
  })

  tunnel.onRpc('conversation.get', async ({ id }) => {
    const found = conversations.find((c) => c.conversation.id === id)
    if (!found) throw new Error(`unknown conversation ${id}`)
    return found.conversation
  })

  tunnel.onRpc('system.check', async () => ({
    ok: true,
    workspace: '~/.wolffish/workspace',
    conversations: conversations.length,
    node: process.version,
    at: Date.now()
  }))

  /**
   * Replays a real turn: the assistant reply streams back token-batch by
   * token-batch as events, exactly like the desktop agent pushing to a phone
   * that is watching the run.
   */
  tunnel.onRpc('agent.run', async ({ prompt, conversationId }) => {
    const source = conversations.find((c) => c.conversation.id === conversationId)
    const reply = source?.conversation.messages.find((m) => m.role === 'assistant')
    const text = (reply?.content ?? 'Done.').slice(0, 2400)
    log.desktop(`agent.run — replaying a real turn (${text.length} chars of assistant output)`)

    tunnel.emit('agent.status', { state: 'thinking', conversationId })
    await sleep(120)
    tunnel.emit('agent.tool', { name: 'workspace.read', detail: 'brain/conversations', ok: true })

    const batches = chunkText(text, 280)
    for (const [i, piece] of batches.entries()) {
      tunnel.emit('agent.delta', { conversationId, seq: i, text: piece })
      await sleep(25)
    }
    tunnel.emit('agent.status', { state: 'done', conversationId })
    return { conversationId, chars: text.length, deltas: batches.length, prompt }
  })

  return {
    async pushFile(file, onProgress) {
      return tunnel.sendFile(path.join(desktopDir, file.name), {
        name: file.name,
        mime: file.mime,
        onProgress
      })
    }
  }
}

export function createMobile({ tunnel, log, mobileDir }) {
  const received = { deltas: [], events: [], files: [] }

  tunnel.onEvent('agent.status', (payload) => {
    received.events.push({ topic: 'agent.status', payload })
    log.mobile(`agent is ${payload.state}`)
  })
  tunnel.onEvent('agent.tool', (payload) => {
    received.events.push({ topic: 'agent.tool', payload })
    log.mobile(`tool ran: ${payload.name} (${payload.detail})`)
  })
  tunnel.onEvent('agent.delta', (payload) => {
    received.deltas.push(payload.text)
  })
  tunnel.onEvent('conversation.updated', (payload) => {
    received.events.push({ topic: 'conversation.updated', payload })
    log.mobile(`conversation ${payload.id} marked updated`)
  })

  return {
    received,

    async writeConfig(config) {
      const file = path.join(mobileDir, 'config.json')
      await fs.writeFile(file, JSON.stringify(config, null, 2))
      const { size } = await fs.stat(file)
      log.mobile(`wrote config.json (${bytes(size)})`)
      return { file, size }
    },

    async writeConversationIndex(rows) {
      const file = path.join(mobileDir, 'conversations-index.json')
      await fs.writeFile(file, JSON.stringify(rows, null, 2))
      log.mobile(`wrote conversation index — ${rows.length} rows`)
      return file
    },

    async writeConversation(conversation) {
      const dir = path.join(mobileDir, 'conversations')
      await fs.mkdir(dir, { recursive: true })
      const file = path.join(dir, `${conversation.id}.json`)
      await fs.writeFile(file, JSON.stringify(conversation, null, 2))
      return file
    },

    async writeTranscript(name, body) {
      const file = path.join(mobileDir, name)
      await fs.writeFile(file, body, 'utf8')
      log.mobile(`wrote ${name} (${bytes(Buffer.byteLength(body))})`)
      return file
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function chunkText(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}
