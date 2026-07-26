'use strict'

class PerKeyTaskQueue {
  constructor() {
    this._tails = new Map()
  }

  enqueue(key, task) {
    const normalizedKey = String(key || 'unknown')
    const previous = this._tails.get(normalizedKey) || Promise.resolve()
    const run = previous.then(() => task())
    let tail
    tail = run
      .catch(() => {})
      .finally(() => {
        if (this._tails.get(normalizedKey) === tail) {
          this._tails.delete(normalizedKey)
        }
      })
    this._tails.set(normalizedKey, tail)
    return run
  }

  get size() {
    return this._tails.size
  }
}

module.exports = { PerKeyTaskQueue }
