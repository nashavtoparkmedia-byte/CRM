// Tiny inactivity watchdog.
//
// Purpose
// ───────
// Wraps a setTimeout so callers don't have to manage the timer-handle
// dance manually. Designed specifically for streaming sessions
// (Yandex STT v3 gRPC, but the helper itself knows nothing about that):
// arm once on stream-start, `reset()` on every incoming event,
// `clear()` on graceful stop. If no event arrives within `timeoutMs`
// the `onTimeout` callback fires — caller is expected to abort the
// stream and propagate as an error through its existing pathway.
//
// Not a generic timeout framework. One file, one function, one
// purpose. If a future caller needs different semantics — write
// another helper, don't widen this one.

'use strict'

/**
 * @param {Object}   opts
 * @param {number}   opts.timeoutMs   — inactivity window. Must be > 0.
 * @param {Function} opts.onTimeout   — fires once if no `reset()` arrives
 *                                       within `timeoutMs` of the last
 *                                       `reset()` (or of the initial
 *                                       arming, which the caller does
 *                                       via the returned `reset()`).
 * @returns {{ reset: () => void, clear: () => void }}
 */
function createInactivityWatchdog({ timeoutMs, onTimeout }) {
    let timer = null

    return {
        /**
         * Arm or rearm the watchdog. Cancels any pending timer and
         * starts a fresh one. Safe to call from the timeout handler
         * itself — the previous timer has already fired and been
         * cleared, so a `reset()` from the handler simply starts a new
         * window (callers typically don't, but the helper doesn't care).
         */
        reset() {
            if (timer) clearTimeout(timer)
            timer = setTimeout(() => {
                timer = null
                onTimeout()
            }, timeoutMs)
        },

        /**
         * Cancel the pending timer if any. Idempotent — safe to call
         * multiple times, safe to call after the timer has already
         * fired. After `clear()`, subsequent `reset()` calls re-arm
         * normally.
         */
        clear() {
            if (timer) {
                clearTimeout(timer)
                timer = null
            }
        },
    }
}

module.exports = { createInactivityWatchdog }
