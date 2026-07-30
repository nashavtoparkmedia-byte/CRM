export class PersonalMaxSendLane {
    private readonly tails = new Map<string, Promise<unknown>>()

    enqueue<T>(routeKey: string, operation: () => Promise<T>): Promise<T> {
        const key = String(routeKey)
        const previous = this.tails.get(key) ?? Promise.resolve()
        const current = previous.catch(() => undefined).then(operation)
        this.tails.set(key, current)
        return current.finally(() => {
            if (this.tails.get(key) === current) this.tails.delete(key)
        })
    }

    get activeLaneCount(): number {
        return this.tails.size
    }
}

// Browser-local ordering begins before the first network await, preserving the
// operator's click order while still allowing independent chats in parallel.
export const personalMaxSendLane = new PersonalMaxSendLane()
