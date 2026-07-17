import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    exclude: [
      ...configDefaults.exclude,
      'scripts/**/*.test.js',
      'src/lib/ai-call/**/*.test.js',
      'src/lib/freeswitch/**/*.test.js',
      'src/lib/users/**/*.test.js',
      'src/lib/__tests__/health.test.js',
      'src/lib/__tests__/redis-health-probe.test.js',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
