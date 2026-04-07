/**
 * useScrollController — unit tests
 *
 * Tests scroll state machine logic. DOM scroll calls (snapToBottom) are
 * no-ops in jsdom (no real layout) — verified in browser integration tests.
 *
 * Run: npx vitest run src/app/messages/hooks/useScrollController.test.ts
 */

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useScrollController } from './useScrollController'
import { UIItem } from '../utils/message-utils'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(
  id: string,
  direction: 'inbound' | 'outbound',
  sentAt = new Date().toISOString()
): UIItem {
  return {
    type: 'message',
    key: id,
    message: {
      id,
      chatId: 'chat1',
      direction,
      content: `Message ${id}`,
      sentAt,
      channel: 'max',
      type: 'text',
      status: 'delivered',
    } as any,
    groupId: `g-${id}`,
    position: 'single',
    showAvatar: direction === 'inbound',
    showName: direction === 'inbound',
    showTail: true,
    spacingTop: 10,
    statusPlacement: 'inline',
  }
}

function makeItems(...specs: Array<{ id: string; dir: 'inbound' | 'outbound' }>): UIItem[] {
  return specs.map(s => makeMsg(s.id, s.dir))
}

vi.mock('react-virtuoso', () => ({}))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useScrollController', () => {
  const CHAT_ID = 'chat-1'

  function mountHook(initialItems: UIItem[] = []) {
    return renderHook(
      ({ chatId, items }) => useScrollController(chatId, items),
      { initialProps: { chatId: CHAT_ID, items: initialItems } }
    )
  }

  // ── 1. followOutput ──────────────────────────────────────────────────────

  describe('followOutput', () => {
    it('always returns false regardless of isAtBottom (Virtuoso auto-scroll disabled)', () => {
      const hook = mountHook()
      expect(hook.result.current.followOutput(true)).toBe(false)
      expect(hook.result.current.followOutput(false)).toBe(false)
    })

    it('is stable (same reference) across renders', () => {
      const hook = mountHook()
      const fn1 = hook.result.current.followOutput
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [] }) })
      expect(hook.result.current.followOutput).toBe(fn1)
    })
  })

  // ── 2. Initial load ──────────────────────────────────────────────────────

  describe('initial load', () => {
    it('starts in stick mode with no badge', () => {
      const items = makeItems({ id: '1', dir: 'inbound' }, { id: '2', dir: 'inbound' })
      const hook = mountHook(items)
      expect(hook.result.current.mode).toBe('stick')
      expect(hook.result.current.showBadge).toBe(false)
    })

    it('does not show badge on initial inbound load', () => {
      const hook = mountHook(makeItems({ id: '1', dir: 'inbound' }))
      expect(hook.result.current.showBadge).toBe(false)
    })
  })

  // ── 3. Inbound at bottom → snap, no badge ───────────────────────────────

  describe('inbound at bottom (stick mode)', () => {
    it('does not show badge when inbound arrives in stick mode', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(true) })
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })

      expect(hook.result.current.showBadge).toBe(false)
      expect(hook.result.current.mode).toBe('stick')
      // snapToBottom() is called — DOM effect verified in browser
    })
  })

  // ── 4. Inbound while scrolled up → badge ────────────────────────────────

  describe('inbound while scrolled up (free mode)', () => {
    it('shows badge when inbound arrives in free mode', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      expect(hook.result.current.mode).toBe('free')

      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })

      expect(hook.result.current.showBadge).toBe(true)
    })

    it('badge disappears when user scrolls back to bottom', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })
      expect(hook.result.current.showBadge).toBe(true)

      act(() => { hook.result.current.onAtBottomChange(true) })
      expect(hook.result.current.showBadge).toBe(false)
      expect(hook.result.current.mode).toBe('stick')
    })

    it('badge click clears badge and switches to stick mode', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })
      expect(hook.result.current.showBadge).toBe(true)

      act(() => { hook.result.current.scrollToBottom() })
      expect(hook.result.current.showBadge).toBe(false)
      expect(hook.result.current.mode).toBe('stick')
    })
  })

  // ── 5. Outbound → stick mode, no badge ──────────────────────────────────

  describe('outbound message', () => {
    it('switches to stick mode and clears badge even when previously in free mode', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      expect(hook.result.current.mode).toBe('free')

      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'outbound')] }) })

      expect(hook.result.current.mode).toBe('stick')
      expect(hook.result.current.showBadge).toBe(false)
    })

    it('clears existing badge when outbound arrives', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })
      expect(hook.result.current.showBadge).toBe(true)

      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound'), makeMsg('3', 'outbound')] }) })
      expect(hook.result.current.showBadge).toBe(false)
    })
  })

  // ── 6. Prepend history → no badge ───────────────────────────────────────

  describe('prepend history', () => {
    it('does not trigger badge when older messages are prepended', () => {
      const initial = makeItems({ id: '10', dir: 'inbound' }, { id: '11', dir: 'inbound' })
      const hook = mountHook(initial)

      const prepended = [makeMsg('8', 'inbound'), makeMsg('9', 'inbound'), ...initial]
      act(() => { hook.rerender({ chatId: CHAT_ID, items: prepended }) })

      expect(hook.result.current.showBadge).toBe(false)
    })
  })

  // ── 7. Chat change resets state ──────────────────────────────────────────

  describe('chat change', () => {
    it('resets mode, badge and seen IDs on chatId change', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      act(() => { hook.rerender({ chatId: CHAT_ID, items: [...initial, makeMsg('2', 'inbound')] }) })
      expect(hook.result.current.showBadge).toBe(true)

      act(() => { hook.rerender({ chatId: 'chat-2', items: [] }) })
      expect(hook.result.current.mode).toBe('stick')
      expect(hook.result.current.showBadge).toBe(false)
    })
  })

  // ── 8. Deduplication ────────────────────────────────────────────────────

  describe('deduplication', () => {
    it('does not re-trigger badge for the same message ID on re-render', () => {
      const initial = makeItems({ id: '1', dir: 'inbound' })
      const hook = mountHook(initial)

      act(() => { hook.result.current.onAtBottomChange(false) })
      const withNew = [...initial, makeMsg('2', 'inbound')]
      act(() => { hook.rerender({ chatId: CHAT_ID, items: withNew }) })
      expect(hook.result.current.showBadge).toBe(true)

      // Badge cleared, scroll back up again
      act(() => { hook.result.current.onAtBottomChange(true) })
      act(() => { hook.result.current.onAtBottomChange(false) })
      // Same items re-render (polling re-fetch with no new messages)
      act(() => { hook.rerender({ chatId: CHAT_ID, items: withNew }) })
      expect(hook.result.current.showBadge).toBe(false)
    })
  })
})
