export interface Env {
  TUNNEL: DurableObjectNamespace
  /**
   * Expo push API access token. The Expo project runs with Enhanced Security
   * for Push Notifications enabled, so every call to exp.host MUST carry this
   * bearer token — without it (or with a stale one) every push send fails.
   * Production: a Worker secret (`wrangler secret put EXPO_ACCESS_TOKEN`).
   * Local: `.dev.vars` (gitignored).
   */
  EXPO_ACCESS_TOKEN: string
  /**
   * Test-only override (milliseconds) for how long an in-band delivery waits
   * for the phone's ack before falling back to Expo push. Unset in production
   * — NOTIFY_ACK_TIMEOUT_MS from protocol.ts applies.
   */
  NOTIFY_ACK_TIMEOUT_MS?: string
}
