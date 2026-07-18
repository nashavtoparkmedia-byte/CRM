'use strict'

const STATES = Object.freeze([
    'idle',
    'connecting',
    'active',
    'reconnecting',
    'backpressured',
    'ended',
    'failed',
])

function createSessionLifecycle({ sessionId, maxBufferedFrames = 8, maxReconnects = 3 } = {}) {
    if (!sessionId) throw new Error('sessionId_required')
    let state = 'idle'
    let reconnects = 0
    let bufferedFrames = 0
    const events = []

    function emit(type, detail = {}) {
        events.push({
            seq: events.length + 1,
            sessionId,
            type,
            detail,
        })
    }

    return {
        get snapshot() {
            return {
                sessionId,
                state,
                reconnects,
                bufferedFrames,
                events: events.map((event) => ({ ...event, detail: { ...event.detail } })),
            }
        },
        connect() {
            if (!['idle', 'reconnecting'].includes(state)) return false
            state = 'connecting'
            emit('connecting')
            return true
        },
        connected() {
            if (state !== 'connecting') return false
            state = 'active'
            emit('connected')
            return true
        },
        disconnect(reason = 'transport_closed') {
            if (['ended', 'failed'].includes(state)) return false
            reconnects += 1
            if (reconnects > maxReconnects) {
                state = 'failed'
                emit('reconnect_exhausted', { reason })
                return false
            }
            state = 'reconnecting'
            emit('reconnect_scheduled', { reason, attempt: reconnects })
            return true
        },
        enqueueFrame() {
            if (!['active', 'backpressured'].includes(state)) return false
            if (bufferedFrames >= maxBufferedFrames) {
                state = 'backpressured'
                emit('frame_dropped', { bufferedFrames, maxBufferedFrames })
                return false
            }
            bufferedFrames += 1
            emit('frame_buffered', { bufferedFrames })
            return true
        },
        flushFrame() {
            if (bufferedFrames > 0) bufferedFrames -= 1
            if (state === 'backpressured' && bufferedFrames < maxBufferedFrames) {
                state = 'active'
                emit('backpressure_recovered', { bufferedFrames })
            }
        },
        timeout(stage = 'unknown') {
            if (['ended', 'failed'].includes(state)) return false
            state = 'failed'
            emit('session_timeout', { stage })
            return true
        },
        end(reason = 'completed') {
            if (['ended', 'failed'].includes(state)) return false
            state = 'ended'
            emit('session_ended', { reason })
            return true
        },
    }
}

module.exports = { STATES, createSessionLifecycle }
