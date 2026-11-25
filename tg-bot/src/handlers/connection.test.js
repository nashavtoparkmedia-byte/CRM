'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')

const connectionPath = require.resolve('./connection')
const userServicePath = require.resolve('../services/userService')
const loggerPath = require.resolve('../utils/logger')

function loadHandler(overrides = {}) {
    const calls = { register: [], updates: [], states: [] }
    const user = {
        telegram_id: '42',
        username: 'driver42',
        first_name: 'Driver',
        last_name: 'Forty Two',
        phone: null,
        phone_verified: 0,
        vu_link: null,
    }
    const service = {
        getUserByTelegramId: async () => user,
        registerUserInCrm: async (row) => {
            calls.register.push(row)
            return overrides.registration ?? { ok: true }
        },
        setUserState: async (...args) => calls.states.push(args),
        updateUser: async (...args) => calls.updates.push(args),
    }
    const logger = { info() {}, error() {} }
    const saved = new Map()
    for (const [name, exports] of [[userServicePath, service], [loggerPath, logger]]) {
        saved.set(name, require.cache[name])
        require.cache[name] = { id: name, filename: name, loaded: true, exports }
    }
    delete require.cache[connectionPath]
    const handler = require('./connection')
    return { handler, calls, user, restore() {
        delete require.cache[connectionPath]
        for (const [name, entry] of saved) {
            if (entry) require.cache[name] = entry
            else delete require.cache[name]
        }
    } }
}

function context(message, replies) {
    return {
        from: { id: 42, username: 'driver42', first_name: 'Driver', last_name: 'Forty Two' },
        message,
        reply: async (text) => { replies.push(text) },
        telegram: { sendMessage: async () => {} },
    }
}

test('connection start requires a successful CRM registration', async () => {
    const loaded = loadHandler({ registration: { ok: false } })
    const replies = []
    try {
        await loaded.handler.startConnectionFlow(context({ text: '🚗 Подключиться' }, replies))
        assert.equal(loaded.calls.register.length, 1)
        assert.match(replies[0], /не удалось зарегистрировать профиль в CRM/i)
    } finally { loaded.restore() }
})
test('connection contact updates local state and confirms only after CRM success', async () => {
    const loaded = loadHandler()
    const replies = []
    try {
        await loaded.handler.handleConnectionData(context({
            contact: { user_id: 42, phone_number: '+79990000000' },
        }, replies))
        assert.deepEqual(loaded.calls.updates[0], [42, {
            status: 'Connection Requested',
            phone: '+79990000000',
        }])
        assert.equal(loaded.calls.register.length, 1)
        assert.match(replies[0], /Профиль подтверждён CRM/)
    } finally { loaded.restore() }
})
