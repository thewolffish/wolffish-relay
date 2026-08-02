import { TUNNEL_PATH_REGEX, isRole } from './protocol'
import type { Env } from './types'

export { Tunnel } from './tunnel'

/**
 * Stateless front door. Validates the request shape and forwards the upgrade
 * to the one Durable Object instance addressed by the rendezvous ID. Holds no
 * state, writes no logs, answers nothing else.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })

    const url = new URL(request.url)

    if (url.pathname === '/healthz') return new Response('ok')
    if (url.pathname === '/') {
      return new Response(
        'wolffish relay — zero-retention tunnel rendezvous. https://github.com/thewolffish/wolffish-relay\n'
      )
    }

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
