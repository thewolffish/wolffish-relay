import { version } from '../package.json'
import { landingPage } from './page'
import { TUNNEL_PATH_REGEX, isRole } from './protocol'
import type { Env } from './types'

export { Tunnel } from './tunnel'

/** Rendered once per isolate — the page is fully static. */
const LANDING_PAGE = landingPage(version)
const LANDING_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'public, max-age=300',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The page needs exactly two things: its inline <style> and the CDN images.
  'content-security-policy':
    "default-src 'none'; img-src https://cdn.wolffi.sh; style-src 'unsafe-inline'"
} as const

/**
 * Stateless front door. Validates the request shape and forwards the upgrade
 * to the one Durable Object instance addressed by the rendezvous ID. Holds no
 * state, writes no logs, answers nothing else.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // HEAD is allowed on the plain routes (uptime checks); the runtime strips the body.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }

    const url = new URL(request.url)

    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname === '/') return new Response(LANDING_PAGE, { headers: LANDING_HEADERS })

    const match = TUNNEL_PATH_REGEX.exec(url.pathname)
    if (!match) return new Response('not found', { status: 404 })

    if (!isRole(url.searchParams.get('role'))) {
      return new Response('role must be host or guest', { status: 400 })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 })
    }

    return env.TUNNEL.get(env.TUNNEL.idFromName(match[1])).fetch(request)
  }
} satisfies ExportedHandler<Env>
