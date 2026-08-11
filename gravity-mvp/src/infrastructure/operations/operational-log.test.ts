import { afterEach, describe, expect, it, vi } from 'vitest'

import { operationalLogV1 } from './operational-log'

afterEach(() => {
  vi.restoreAllMocks()
})
describe('operationalLogV1', () => {
  it('preserves info JSON-line delivery to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    operationalLogV1('info', 'call_started', { operation: 'start', callId: 'call-1' })
    expect(write).toHaveBeenCalledTimes(1)
    const entry = JSON.parse(String(write.mock.calls[0][0]))
    expect(entry).toMatchObject({ level: 'info', event: 'call_started', operation: 'start', callId: 'call-1' })
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false)
  })

  it('preserves error JSON-line delivery to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    operationalLogV1('error', 'call_failed', { errorCode: 'ESL_DOWN' })
    expect(write).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      level: 'error', event: 'call_failed', errorCode: 'ESL_DOWN',
    })
  })

  it('remains fail-safe when context serialization fails', () => {
    const fallback = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => operationalLogV1('warn', 'bad_context', { value: 1n })).not.toThrow()
    expect(fallback).toHaveBeenCalledWith('[opsLog-fallback] level=warn event=bad_context')
  })
})
