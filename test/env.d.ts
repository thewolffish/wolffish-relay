import type { Env as RelayEnv } from '../src/types'

/**
 * Type `env` from `cloudflare:test` as this Worker's own Env, so tests can
 * reach `env.TUNNEL` and `env.EXPO_ACCESS_TOKEN` without casts.
 */
declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging, not a subtype
    interface Env extends RelayEnv {}
  }
}

export {}
