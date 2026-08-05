import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Deterministic secrets for the mocked Expo API (tests never reach
          // the real exp.host), and a short ack window so the fallback tests
          // don't wait out the production 2 s timer.
          EXPO_ACCESS_TOKEN: 'test-expo-token',
          NOTIFY_ACK_TIMEOUT_MS: '150'
        }
      }
    })
  ],
  test: {}
})
