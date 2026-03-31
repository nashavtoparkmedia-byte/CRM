'use strict'

/**
 * ContactStore — хранит имена контактов из opcode 32 (CONTACTS).
 * userId (number) → { name, firstName, lastName }
 */
class ContactStore {
  constructor() {
    this._map = new Map()
  }

  /**
   * Обработать payload opcode 32
   */
  ingest(payload) {
    const contacts = payload.contacts || []
    for (const c of contacts) {
      const userId = c.id
      if (!userId) continue
      const nameObj = (c.names || [])[0] || {}
      this._map.set(String(userId), {
        name:      nameObj.name      || null,
        firstName: nameObj.firstName || null,
        lastName:  nameObj.lastName  || null,
        phone:     c.phone ? String(c.phone) : null,
      })
    }
    console.log(`[ContactStore] Loaded ${this._map.size} contacts`)
  }

  /**
   * Получить отображаемое имя по userId
   */
  getName(userId) {
    const c = this._map.get(String(userId))
    if (!c) return null
    if (c.firstName && c.lastName) return `${c.firstName} ${c.lastName}`.trim()
    return c.firstName || c.name || null
  }

  /**
   * Получить телефон по userId
   */
  getPhone(userId) {
    return this._map.get(String(userId))?.phone || null
  }

  /**
   * Есть ли контакт
   */
  has(userId) {
    return this._map.has(String(userId))
  }
}

module.exports = { ContactStore }
