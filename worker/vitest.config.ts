import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  // Pinned to this directory. Vitest resolves `include` against its root, which
  // is the process working directory unless told otherwise — so running the
  // worker suite from the repo root found no tests at all, silently.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            ALLOWED_ORIGIN: 'https://parshvak26.github.io',
            DAILY_TURN_CEILING: '600',
            KILL_SWITCH: 'off',
            SESSION_SECRET: 'test-secret-not-a-real-one',
            TURNSTILE_SECRET: 'test-turnstile-secret',
            MODEL_API_KEY: 'test-model-key',
            TTS_API_KEY: 'test-tts-key',
            STT_API_KEY: 'test-stt-key',
            MODEL_NAME: 'llama-3.3-70b-versatile',
            TTS_MODEL: 'playai-tts',
            TTS_VOICE: 'Celeste-PlayAI',
            STT_MODEL: 'whisper-large-v3-turbo',
          },
          kvNamespaces: ['STATE'],
        },
      },
    },
  },
});
