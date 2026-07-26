'use strict'

class SerializedOutboundQueue {
  constructor() {
    this._items = []
    this._active = false
  }

  enqueue(task) {
    if (typeof task !== 'function') {
      return Promise.reject(new TypeError('outbound task must be a function'))
    }

    return new Promise((resolve, reject) => {
      this._items.push({ task, resolve, reject })
      this._drain().catch(error => {
        console.error('[OutboundQueue] drain failed:', error.message)
      })
    })
  }

  async _drain() {
    if (this._active) return
    this._active = true

    try {
      while (this._items.length > 0) {
        const item = this._items.shift()
        try {
          item.resolve(await item.task())
        } catch (error) {
          item.reject(error)
        }
      }
    } finally {
      this._active = false
      if (this._items.length > 0) {
        await this._drain()
      }
    }
  }

  get size() {
    return this._items.length + (this._active ? 1 : 0)
  }
}

module.exports = { SerializedOutboundQueue }
