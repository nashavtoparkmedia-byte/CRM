const test = require('node:test')
const assert = require('node:assert/strict')
const { STATES, createSessionLifecycle } = require('../session-lifecycle')

test('lifecycle connects and ends deterministically', () => {
    const session = createSessionLifecycle({ sessionId: 'mock-session' })
    assert.equal(session.connect(), true)
    assert.equal(session.connected(), true)
    assert.equal(session.end(), true)
    assert.equal(session.snapshot.state, 'ended')
    assert.deepEqual(session.snapshot.events.map((event) => event.type), [
        'connecting',
        'connected',
        'session_ended',
    ])
})

test('disconnect reconnects with a bounded attempt count', () => {
    const session = createSessionLifecycle({ sessionId: 'reconnect', maxReconnects: 1 })
    session.connect()
    session.connected()
    assert.equal(session.disconnect(), true)
    session.connect()
    session.connected()
    assert.equal(session.disconnect(), false)
    assert.equal(session.snapshot.state, 'failed')
})

test('backpressure drops overflow and recovers after flush', () => {
    const session = createSessionLifecycle({ sessionId: 'pressure', maxBufferedFrames: 1 })
    session.connect()
    session.connected()
    assert.equal(session.enqueueFrame(), true)
    assert.equal(session.enqueueFrame(), false)
    assert.equal(session.snapshot.state, 'backpressured')
    session.flushFrame()
    assert.equal(session.snapshot.state, 'active')
})

test('timeout produces a terminal structured event', () => {
    const session = createSessionLifecycle({ sessionId: 'timeout' })
    session.connect()
    assert.equal(session.timeout('stt'), true)
    assert.equal(session.snapshot.state, 'failed')
    assert.equal(session.snapshot.events.at(-1).type, 'session_timeout')
})

test('state contract is explicit and immutable', () => {
    assert.ok(STATES.includes('reconnecting'))
    assert.ok(STATES.includes('backpressured'))
    assert.equal(Object.isFrozen(STATES), true)
})
