/**
 * Per-park tenure queue, inside one process.
 *
 * The database lease fences writes between processes; this queue decides
 * which work inside this process gets the next tenure on a park, so a steady
 * stream of targeted confirmations can never starve the background hot pass
 * and a long reconciliation pass can never starve a driver's confirmation:
 *
 *   1. the background hot pass of the current tick (while a tick has a hot
 *      pass pending for the park, nothing else starts on it)
 *   2. queued targeted slices, first in, first out
 *   3. reconciliation, which re-enters the queue before every slice
 *
 * A tenure covers one slice. Holders release it after the slice's final page
 * commits, which is where waiting work gets its turn.
 */

export type CashOrderTenurePriorityV1 = 'background_hot' | 'targeted' | 'reconciliation'

const RANK: Record<CashOrderTenurePriorityV1, number> = { background_hot: 0, targeted: 1, reconciliation: 2 }

interface Waiter {
    rank: number
    sequence: number
    grant: (release: () => void) => void
}

export class CashOrderParkTenureQueueV1 {
    private held = false
    private pendingBackgroundHot = 0
    private sequence = 0
    private readonly waiters: Waiter[] = []

    /** A tick has a background hot pass to run on this park. */
    beginBackgroundHot(): void {
        this.pendingBackgroundHot += 1
    }

    /** That hot pass ended, ran or not. */
    endBackgroundHot(): void {
        if (this.pendingBackgroundHot > 0) this.pendingBackgroundHot -= 1
        this.dispatch()
    }

    hasWaiting(priority: CashOrderTenurePriorityV1): boolean {
        return this.waiters.some((waiter) => waiter.rank === RANK[priority])
    }

    /**
     * Resolves with a release function once this work holds the tenure, or
     * with null if `abandon` settles first. An abandoned waiter never holds
     * the tenure.
     */
    acquire(priority: CashOrderTenurePriorityV1, abandon: Promise<unknown>): Promise<(() => void) | null> {
        return new Promise((resolve) => {
            let settled = false
            const waiter: Waiter = {
                rank: RANK[priority],
                sequence: this.sequence++,
                grant: (release) => {
                    settled = true
                    resolve(release)
                },
            }
            this.waiters.push(waiter)
            this.dispatch()
            abandon.then(() => {
                if (settled) return
                settled = true
                const index = this.waiters.indexOf(waiter)
                if (index >= 0) this.waiters.splice(index, 1)
                resolve(null)
            }, () => undefined)
        })
    }

    private dispatch(): void {
        if (this.held || this.waiters.length === 0) return
        this.waiters.sort((left, right) => left.rank - right.rank || left.sequence - right.sequence)
        const next = this.waiters[0]
        if (this.pendingBackgroundHot > 0 && next.rank !== RANK.background_hot) return
        this.waiters.shift()
        this.held = true
        let released = false
        next.grant(() => {
            if (released) return
            released = true
            this.held = false
            this.dispatch()
        })
    }
}
