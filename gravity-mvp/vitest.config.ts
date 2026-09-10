import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'server-only-test-sentinel',
      enforce: 'pre',
      resolveId(id) {
        return id === 'server-only' ? '\0server-only-test-sentinel' : null
      },
      load(id) {
        return id === '\0server-only-test-sentinel' ? 'export {}' : null
      },
    },
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
