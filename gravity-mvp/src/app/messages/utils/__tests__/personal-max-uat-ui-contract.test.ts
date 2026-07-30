import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { personalMaxMessagePresentation } from '../personal-max-message-status'
import { createSubmitActivationGate } from '../submit-activation-gate'

const outbound = (status: string, durableStatus: string, retryable = false) => ({
  channel: 'max', direction: 'outbound', status,
  metadata: { retryable, maxDelivery: { status: durableStatus, deliveryConfirmed: status === 'delivered' } },
})

describe('Personal MAX UAT UI contract', () => {
  it('maps durable queued to a neutral queue label', () => {
    expect(personalMaxMessagePresentation(outbound('queued', 'queued')))
      .toEqual({ kind: 'queued', label: 'В очереди', retryAllowed: false })
  })

  it('maps an active durable attempt to sending', () => {
    expect(personalMaxMessagePresentation(outbound('sent', 'sending')))
      .toEqual({ kind: 'sending', label: 'Отправляется', retryAllowed: false })
  })

  it('maps exact provider confirmation to confirmed without retry', () => {
    expect(personalMaxMessagePresentation(outbound('delivered', 'delivered')))
      .toEqual({ kind: 'confirmed', label: 'Подтверждено MAX', retryAllowed: false })
  })

  it('does not present a confirmation label without explicit confirmation evidence', () => {
    expect(personalMaxMessagePresentation(outbound('sent', 'accepted_by_max')))
      .toEqual({ kind: 'checking', label: 'Проверяем отправку', retryAllowed: false })
  })

  it('maps unknown outcome to checking and forbids blind retry', () => {
    expect(personalMaxMessagePresentation(outbound('sent', 'needs_review', true)))
      .toEqual({ kind: 'checking', label: 'Проверяем отправку', retryAllowed: false })
  })

  it('offers retry only for exact pre-action retryable failure', () => {
    expect(personalMaxMessagePresentation(outbound('failed', 'retryable_failed', true)))
      .toEqual({ kind: 'failed', label: 'Не отправлено', retryAllowed: true })
    expect(personalMaxMessagePresentation(outbound('failed', 'hard_failed', true)).retryAllowed).toBe(false)
  })

  it('suppresses duplicate handlers from one synchronous send activation', () => {
    const releases: Array<() => void> = []
    const gate = createSubmitActivationGate(release => releases.push(release))
    expect(gate.claim()).toBe(true)
    expect(gate.claim()).toBe(false)
    expect(releases).toHaveLength(1)
  })

  it('allows two deliberate identical sends after separate UI activations', () => {
    const releases: Array<() => void> = []
    const gate = createSubmitActivationGate(release => releases.push(release))
    expect(gate.claim()).toBe(true)
    releases.shift()?.()
    expect(gate.claim()).toBe(true)
  })

  it('manual retry calls the retry endpoint path and never creates a new message bubble', () => {
    const workspace = fs.readFileSync('src/app/messages/components/ChatWorkspace.tsx', 'utf8')
    const start = workspace.indexOf('const handleRetry =')
    const end = workspace.indexOf('\n    const handleReply', start)
    const block = workspace.slice(start, end)
    expect(block).toContain('retryMessage(msg.id)')
    expect(block).not.toContain('sendMessage(')
  })

  it('registers MAX sends in the per-chat lane before starting network I/O', () => {
    const hook = fs.readFileSync('src/app/messages/hooks/useMessages.ts', 'utf8')
    const start = hook.indexOf('const request = () => fetch')
    const end = hook.indexOf('if (res.ok)', start)
    const block = hook.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(block).toContain("apiChannel === 'max'")
    expect(block).toContain('personalMaxSendLane.enqueue(primaryChatId, request)')
    expect(block.indexOf('personalMaxSendLane.enqueue')).toBeLessThan(block.indexOf('await request()'))
  })
})
