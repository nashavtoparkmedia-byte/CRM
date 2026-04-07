'use client'

/**
 * useScrollController — scroll state machine for MessageFeed
 *
 * Initial bottom positioning: Virtuoso handles it via initialTopMostItemIndex=lastIndex.
 * We must NOT write el.scrollTop during Virtuoso's own initialTopMostItemIndex scroll —
 * Virtuoso applies visibility:hidden until scroll completes; external scrollTop writes
 * fight its internal state → visibility:hidden never removed → 0 items rendered.
 * ResizeObserver (mode=stick) corrects any residual gap after items render.
 *
 * WHY followOutput IS DISABLED (always returns false):
 *   followOutput('auto') triggers Virtuoso's internal scrollToIndex which uses
 *   estimated heights — fights our ResizeObserver gap correction.
 *
 * SCROLL POSITION PERSISTENCE:
 *   Uses item-index + anchorOffset restore, not raw scrollTop. scrollTop is pixel-
 *   unstable in a virtualized list (cumulative estimated heights vary per session).
 *   Saved: in two places — (1) scroll listener on every scroll event, and (2)
 *     synchronously in scrollerRef(elB) from the OLD element when the new element
 *     arrives (elA is still in DOM, chatIdRef = old chatId, Virtuoso settled).
 *   WHY NOT in scrollerRef(null):
 *     Virtuoso has key={chatId} so it remounts on each chat switch. React processes
 *     the new Virtuoso's insertion BEFORE the old one's deletion. Therefore:
 *       scrollerRef(elB) fires first → scrollerDomRef.current = elB
 *       scrollerRef(null) fires second → prev = elB (wrong element!)
 *     Fix: ignore null calls. Save from the elB call while elA is still valid.
 *   Restored: initialTopMostItemIndex (Virtuoso prop) + BCR delta correction loop
 *     with STABLE_FRAMES to absorb Virtuoso's trailing height corrections.
 *
 * WHY snapToBottom() PHASES 2/3 DON'T CHECK modeRef:
 *   After Phase 1 (el.scrollTop = el.scrollHeight), Virtuoso may briefly fire
 *   atBottomStateChange(false) because the estimated scrollHeight is not at
 *   Virtuoso's detected "at bottom" threshold. This sets modeRef='free', which
 *   previously aborted Phase 2/3 — leaving us at estimated bottom. ~0.5s later,
 *   the opt→real transition sees a gap and fires a second snap (visible drift).
 *   Fix: snapToBottom() always completes all phases; modeRef guard is only in
 *   the ResizeObserver (automatic, reactive) snap.
 *
 * WHY ResizeObserver USES DIRECT CORRECTION FOR SMALL GAPS:
 *   For tiny height adjustments (status icon change, spacing delta < 50px), doing
 *   Phase 1 (jump to estimated scrollHeight) and then Phase 2 correction causes a
 *   visible 1-frame overshoot. For small gaps, directly add the gap without Phase 1.
 *
 * WHY ResizeObserver DOES NOT snap() IMMEDIATELY ON MODE ACTIVATION:
 *   Mode switch triggers ResizeObserver effect re-run. An immediate snap() competes
 *   with explicit snapToBottom() calls → oscillation. Only fires on content changes.
 *
 * Modes:
 *   stick — ResizeObserver holds bottom; snapToBottom on new messages
 *   free  — ResizeObserver disconnected; badge shown for new inbound
 */

import { useRef, useState, useEffect, useCallback } from 'react'
import { VirtuosoHandle } from 'react-virtuoso'
import { UIItem } from '../utils/message-utils'

export type ScrollMode = 'stick' | 'free'

export interface ScrollController {
  virtuosoRef: React.RefObject<VirtuosoHandle | null>
  scrollerRef: (el: HTMLElement | Window | null) => void
  mode: ScrollMode
  showBadge: boolean
  shouldStartAtBottom: boolean
  restoreItemIndex: number   // ≥0: restore to this item index; -1: use list-end (bottom)
  followOutput: (isAtBottom: boolean) => 'auto' | false
  onAtBottomChange: (atBottom: boolean) => void
  scrollToBottom: () => void
}

// ── Per-chat scroll state persisted across chat switches ─────────────────────
interface ChatScrollState {
  scrollTop: number
  wasAtBottom: boolean
  itemIndex: number    // first visible item index at time of save; -1 if unknown
  anchorOffset: number // px from scroller top to anchor item's top (can be negative)
}
const chatScrollHistory = new Map<string, ChatScrollState>()

export function useScrollController(
  chatId: string,
  uiItems: UIItem[]
): ScrollController {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerDomRef = useRef<HTMLElement | null>(null)
  const [mode, setMode] = useState<ScrollMode>('stick')
  const [showBadge, setShowBadge] = useState(false)

  const modeRef = useRef<ScrollMode>('stick')
  const seenIds = useRef(new Set<string>())
  const isInitialLoad = useRef(true)
  const isRestoringRef = useRef(false)

  // Live scroll tracking refs — updated by scroll listener.
  const scrollTopRef = useRef(0)
  const scrollHeightRef = useRef(0)
  const clientHeightRef = useRef(0)
  // First visible item index — updated on scroll, saved in cleanup.
  // Item-index based restore is pixel-stable in virtualized lists; raw scrollTop is not.
  const firstVisibleIndexRef = useRef(-1)
  // Pixel offset from scroller top to anchor item's top at time of save (can be negative).
  const anchorOffsetRef = useRef(0)

  // Computed for current chatId
  const savedState = chatScrollHistory.get(chatId)
  const shouldStartAtBottom = !savedState || savedState.wasAtBottom
  const restoreItemIndex = !shouldStartAtBottom && savedState && savedState.itemIndex >= 0
    ? savedState.itemIndex
    : -1

  // Refs so the uiItems effect can read current values without re-running on chatId change.
  const chatIdRef = useRef(chatId)
  const shouldStartAtBottomRef = useRef(shouldStartAtBottom)

  // ── Reset on chat change ────────────────────────────────────────────────────
  useEffect(() => {
    chatIdRef.current = chatId
    shouldStartAtBottomRef.current = shouldStartAtBottom

    isRestoringRef.current = false
    seenIds.current = new Set()
    modeRef.current = shouldStartAtBottom ? 'stick' : 'free'
    setMode(shouldStartAtBottom ? 'stick' : 'free')
    setShowBadge(false)
    isInitialLoad.current = true
    scrollTopRef.current = 0
    scrollHeightRef.current = 0
    clientHeightRef.current = 0
    firstVisibleIndexRef.current = -1
    anchorOffsetRef.current = 0

    return () => {
      // Scroll state is saved in scrollerRef(null) — see that callback for why.
      // Here we only reset transient refs so the next chatId starts clean.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId])

  // ── Scroller accessor ───────────────────────────────────────────────────────
  const getScroller = useCallback((): HTMLElement | null =>
    scrollerDomRef.current ??
    (document.querySelector('.message-scroller') as HTMLElement | null),
  [])

  // ── Distance from true bottom (last rendered [data-index] element) ──────────
  const getBottomGap = useCallback((el: HTMLElement): number => {
    const items = el.querySelectorAll<HTMLElement>('[data-index]')
    const last = items[items.length - 1]
    if (!last) return el.scrollHeight - el.clientHeight - el.scrollTop
    return last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom
  }, [])

  // ── Core snap primitive ─────────────────────────────────────────────────────
  // Phases 2/3 do NOT check modeRef — see file header comment.
  const snapToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = getScroller()
    if (!el) return

    if (behavior === 'smooth') {
      const items = el.querySelectorAll<HTMLElement>('[data-index]')
      const last = items[items.length - 1]
      const gap = last
        ? last.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom
        : el.scrollHeight - el.clientHeight - el.scrollTop
      if (gap > 0.5) el.scrollTo({ top: el.scrollTop + gap, behavior: 'smooth' })
      return
    }

    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      if (!el) return
      const gap1 = getBottomGap(el)
      if (gap1 > 0.5) el.scrollTop += gap1
      requestAnimationFrame(() => {
        const gap2 = getBottomGap(el)
        if (gap2 > 0.5) el.scrollTop += gap2
      })
    })
  }, [getScroller, getBottomGap])

  // ── ResizeObserver: maintain true bottom while in stick mode ────────────────
  useEffect(() => {
    if (mode !== 'stick') return

    let snapRafId = 0
    let verifyRafId = 0
    let verifyRafId2 = 0
    let ro: ResizeObserver | null = null

    const setupRafId = requestAnimationFrame(() => {
      const el = getScroller()
      if (!el) return

      const snap = () => {
        cancelAnimationFrame(snapRafId)
        snapRafId = requestAnimationFrame(() => {
          if (modeRef.current !== 'stick') return

          const immediateGap = getBottomGap(el)
          if (immediateGap <= 0.5) return  // Already at true bottom

          if (immediateGap <= 50) {
            // Small gap (status change, spacing delta): correct directly without
            // Phase 1 jump to avoid the 1-frame overshoot that causes visible drift.
            el.scrollTop += immediateGap
            cancelAnimationFrame(verifyRafId)
            verifyRafId = requestAnimationFrame(() => {
              if (modeRef.current !== 'stick') return
              const residual = getBottomGap(el)
              if (residual > 0.5) el.scrollTop += residual
            })
            return
          }

          // Large gap (new message below viewport): Phase 1 forces Virtuoso to
          // render bottom items, then Phase 2/3 correct for actual heights.
          el.scrollTop = el.scrollHeight
          cancelAnimationFrame(verifyRafId)
          verifyRafId = requestAnimationFrame(() => {
            if (modeRef.current !== 'stick') return
            const gap1 = getBottomGap(el)
            if (gap1 > 0.5) el.scrollTop += gap1
            cancelAnimationFrame(verifyRafId2)
            verifyRafId2 = requestAnimationFrame(() => {
              if (modeRef.current !== 'stick') return
              const gap2 = getBottomGap(el)
              if (gap2 > 0.5) el.scrollTop += gap2
            })
          })
        })
      }

      const child = el.firstElementChild as HTMLElement | null
      if (child) {
        ro = new ResizeObserver(snap)
        ro.observe(child)
      }
      // No immediate snap() — would compete with explicit snapToBottom() calls.
    })

    return () => {
      cancelAnimationFrame(setupRafId)
      cancelAnimationFrame(snapRafId)
      cancelAnimationFrame(verifyRafId)
      cancelAnimationFrame(verifyRafId2)
      ro?.disconnect()
    }
  }, [mode, getScroller, getBottomGap])

  // ── New message detection ───────────────────────────────────────────────────
  // chatId and shouldStartAtBottom are NOT in deps — see file header comment.
  useEffect(() => {
    if (uiItems.length === 0) return

    if (isInitialLoad.current) {
      isInitialLoad.current = false
      uiItems.forEach(item => {
        if (item.type === 'message') seenIds.current.add(item.message.id)
      })

      if (shouldStartAtBottomRef.current) {
        // MessageFeed sets initialTopMostItemIndex=0 (NOT lastIndex) to avoid Virtuoso's
        // visibility:hidden deadlock (stuck when scrollHeight=clientHeight before items
        // render). Items start visible at top; we jump to true bottom via scrollToIndex.
        //
        // WHY scrollToIndex (not el.scrollTop): Virtuoso's ResizeObserver overrides direct
        // scrollTop writes. scrollToIndex is processed internally — no fight-back.
        //
        // increaseViewportBy=1000 pre-renders ALL items even from scrollTop=0, so
        // scrollToIndex has real item positions available immediately.
        const targetIndex = uiItems.length - 1
        requestAnimationFrame(() => requestAnimationFrame(() => {
          virtuosoRef.current?.scrollToIndex({ index: targetIndex, align: 'end', behavior: 'auto' })
        }))
      } else {
        // Restore via Virtuoso's own scrollToIndex API.
        //
        // WHY scrollToIndex instead of direct el.scrollTop manipulation:
        //   Setting el.scrollTop externally is overridden by Virtuoso's ResizeObserver
        //   whenever item heights are re-measured (e.g. images loading, layout settling).
        //   scrollToIndex is processed INTERNALLY by Virtuoso — it maintains the position
        //   even as it adjusts estimated heights, so there is no fight-back loop.
        //
        // STRATEGY:
        //   1. waitSettle — watch scrollTop without touching it. Wait until Virtuoso stops
        //      its own ResizeObserver corrections (stable for SETTLE_FRAMES consecutive frames).
        //      This ensures Virtuoso has measured real item heights before we issue scrollToIndex.
        //   2. Apply scrollToIndex with align:'start' + offset:anchorOffset so the saved anchor
        //      item lands exactly anchorOffset px below the scroller top.
        isRestoringRef.current = true
        const saved = chatScrollHistory.get(chatIdRef.current)

        const SETTLE_FRAMES = 10   // ~167ms of scrollTop stability → Virtuoso has settled
        const restoreStart = Date.now()

        const tryRestore = (stableCount: number, lastScrollTop: number) => {
          if (Date.now() - restoreStart > 5000) {
            isRestoringRef.current = false
            return
          }

          const el = getScroller()
          if (!el || !saved || saved.itemIndex < 0) {
            isRestoringRef.current = false
            return
          }

          const curST = el.scrollTop

          if (Math.abs(curST - lastScrollTop) > 0.5) {
            // Virtuoso still adjusting — reset counter
            requestAnimationFrame(() => tryRestore(0, curST))
          } else if (stableCount < SETTLE_FRAMES) {
            requestAnimationFrame(() => tryRestore(stableCount + 1, curST))
          } else {
            // Virtuoso has settled with real heights — use scrollToIndex so Virtuoso
            // owns the position and won't fight us back via its ResizeObserver.
            // offset: anchorOffset = px from scroller top to anchor item top (positive = below top).
            virtuosoRef.current?.scrollToIndex({
              index: saved.itemIndex,
              align: 'start',
              behavior: 'auto',
              offset: saved.anchorOffset,
            })
            isRestoringRef.current = false
          }
        }

        // Wait two rAFs: first for Virtuoso to mount items via initialTopMostItemIndex,
        // second for initial layout pass, then start watching for settle.
        const initEl = getScroller()
        requestAnimationFrame(() => requestAnimationFrame(() =>
          tryRestore(0, initEl?.scrollTop ?? 0)
        ))
      }
      return
    }

    const lastItem = uiItems[uiItems.length - 1]
    if (lastItem?.type !== 'message') return
    const msgId = lastItem.message.id
    if (seenIds.current.has(msgId)) return
    seenIds.current.add(msgId)

    if (lastItem.message.direction === 'outbound') {
      const el = getScroller()
      // Use getBottomGap (true DOM position of last rendered item), not scrollHeight estimate.
      // When new message is inserted, Virtuoso adds estimated height to scrollHeight before
      // rendering the item. scrollHeight-based check → alreadyAtBottom=false → snapToBottom
      // overshoots into empty space. getBottomGap uses last rendered [data-index] item
      // which is still the previous message → at viewport bottom → gap≤0 → skip snap.
      const alreadyAtBottom = el ? getBottomGap(el) <= 10 : false

      setShowBadge(false)
      if (modeRef.current !== 'stick') {
        modeRef.current = 'stick'
        setMode('stick')
      }
      if (!alreadyAtBottom) {
        snapToBottom()
      }
    } else {
      if (modeRef.current === 'free') {
        setShowBadge(true)
      } else {
        const el = getScroller()
        const alreadyAtBottom = el ? getBottomGap(el) <= 10 : false
        if (!alreadyAtBottom) snapToBottom()
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiItems, snapToBottom, getScroller, getBottomGap])

  // ── Anchor measurement helper (reused in scrollerRef and scroll listener) ────
  const measureAnchor = useCallback((el: HTMLElement): { itemIndex: number; anchorOffset: number } => {
    const scrollerRect = el.getBoundingClientRect()
    const items = el.querySelectorAll<HTMLElement>('[data-index]')
    const isMsg = (item: HTMLElement) => item.querySelector('[data-item-type="message"]') !== null
    let itemIndex = -1
    let anchorOffset = 0
    for (const item of items) {
      if (!isMsg(item)) continue
      const rect = item.getBoundingClientRect()
      if (rect.top >= scrollerRect.top - 1) {
        itemIndex = parseInt(item.getAttribute('data-index') || '-1', 10)
        anchorOffset = rect.top - scrollerRect.top
        break
      }
    }
    if (itemIndex === -1) {
      for (const item of items) {
        if (!isMsg(item)) continue
        const rect = item.getBoundingClientRect()
        if (rect.bottom > scrollerRect.top) {
          itemIndex = parseInt(item.getAttribute('data-index') || '-1', 10)
          anchorOffset = rect.top - scrollerRect.top
          break
        }
      }
    }
    return { itemIndex, anchorOffset }
  }, [])

  // ── scrollerRef callback ────────────────────────────────────────────────────
  //
  // CRITICAL ORDERING — Virtuoso calls scrollerRef in this order on chat switch:
  //   1. scrollerRef(elB)  — new Virtuoso mounts (React inserts before deleting)
  //   2. scrollerRef(null) — old Virtuoso unmounts
  //
  // If we naively track prev=scrollerDomRef.current, the null call in step 2 finds
  // prev=elB (the NEW element, just set in step 1) and removes elB's listener. Fix:
  //   • Ignore null calls entirely — old Virtuoso's null arrives after new Virtuoso
  //     already owns scrollerDomRef. Cleanup happens in step 1 (when elB arrives
  //     and we see prev=elA, the real old element).
  //   • In step 1, save elA's scroll state synchronously before detaching. At this
  //     point elA is still connected to the DOM, chatIdRef.current = OLD chatId,
  //     and Virtuoso has had time to settle its ResizeObserver passes.
  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    const next = el instanceof HTMLElement ? el : null

    // Ignore null calls: they come from the OLD Virtuoso unmounting AFTER the new
    // one already mounted and set scrollerDomRef. Acting on null would remove the
    // new element's listener. The real cleanup happens when the new element arrives.
    if (next === null) return

    const prev = scrollerDomRef.current
    scrollerDomRef.current = next

    if (prev && prev !== next) {
      // New element replacing old one. Save old element's final scroll state
      // synchronously — at this moment:
      //   - prev (elA) is still connected to the DOM
      //   - chatIdRef.current is still the OLD chatId (effects haven't fired yet)
      //   - Virtuoso has settled its ResizeObserver passes (user was idle before switching)
      // This captures the Virtuoso-stable anchorOffset, not an estimated one.
      if (!isRestoringRef.current) {
        const sh = prev.scrollHeight, ch = prev.clientHeight, st = prev.scrollTop
        if (sh > 0) {
          const { itemIndex, anchorOffset } = measureAnchor(prev)
          chatScrollHistory.set(chatIdRef.current, {
            scrollTop: st,
            wasAtBottom: sh - ch - st <= 5,
            itemIndex,
            anchorOffset,
          })
        }
      }
      prev.removeEventListener('scroll', (prev as any).__scrollTracker)
    }

    const onScroll = () => {
      const sh = next.scrollHeight
      const ch = next.clientHeight
      const st = next.scrollTop
      scrollTopRef.current = st
      scrollHeightRef.current = sh
      clientHeightRef.current = ch

      const { itemIndex, anchorOffset } = measureAnchor(next)
      firstVisibleIndexRef.current = itemIndex
      anchorOffsetRef.current = anchorOffset

      // Don't overwrite saved state while restore is running — Virtuoso's
      // ResizeObserver may fire scroll events mid-restore with stale positions.
      if (sh > 0 && !isRestoringRef.current) {
        chatScrollHistory.set(chatIdRef.current, {
          scrollTop: st,
          wasAtBottom: sh - ch - st <= 5,
          itemIndex,
          anchorOffset,
        })
      }
    }
    ;(next as any).__scrollTracker = onScroll
    next.addEventListener('scroll', onScroll, { passive: true })
  }, [measureAnchor])

  // ── followOutput: always false ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const followOutput = useCallback((_isAtBottom: boolean): 'auto' | false => false, [])

  // ── atBottomStateChange ─────────────────────────────────────────────────────
  const onAtBottomChange = useCallback((atBottom: boolean) => {
    if (isRestoringRef.current) return
    const newMode: ScrollMode = atBottom ? 'stick' : 'free'
    if (modeRef.current === newMode) {
      if (atBottom) setShowBadge(false)
      return
    }
    modeRef.current = newMode
    setMode(newMode)
    if (atBottom) setShowBadge(false)
  }, [])

  // ── Badge click ─────────────────────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    modeRef.current = 'stick'
    setMode('stick')
    setShowBadge(false)
    snapToBottom('smooth')
  }, [snapToBottom])

  return {
    virtuosoRef,
    scrollerRef,
    mode,
    showBadge,
    shouldStartAtBottom,
    restoreItemIndex,
    followOutput,
    onAtBottomChange,
    scrollToBottom,
  }
}
