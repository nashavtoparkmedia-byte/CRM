import { afterEach, describe, expect, test, vi } from 'vitest'

import { register } from './instrumentation'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('isolated Messages browser mode', () => {
  test('does not start provider listeners or background timers in development', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('MESSAGES_BROWSER_TEST_MODE', '1')
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    await register()

    expect(timeoutSpy).not.toHaveBeenCalled()
  })
})
