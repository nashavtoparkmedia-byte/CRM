// Regression harness for the per-channel AI-call lifecycle (channel-lifecycle.js).
//
// Why this file exists: the bridge used to start the audio fork only on a
// CHANNEL_ANSWER whose destination was the AI extension. For the production
// originate `originate {...}sofia/gateway/megafon/<n> 9999 XML default`, a callee
// that sends no early media produces a CHANNEL_ANSWER that still names the callee
// (it is emitted before the transfer into 9999), so the call was never forked
// (deaf) and its queued greeting never played (mute).
//
// The two capture fixtures below are real FreeSWITCH 1.10.12 events recorded
// with an ESL observer for exactly that originate shape, with loopback callees:
// 5556 sends early media then answers, 5557 answers after 2 s with no early media.
// Only the headers the lifecycle reads are kept. The "-b" legs are the loopback
// callee legs and must never be forked.
//
// Run: `node --test __tests__/channel-lifecycle.test.js`

const test = require('node:test')
const assert = require('node:assert/strict')

const {
    createChannelLifecycle,
    createSessionResolver,
    parseEslEventHeaders,
    buildAudioForkCommand,
    DEFAULT_DEAD_CHANNEL_TTL_MS,
    DEFAULT_PRE_ANSWER_TIMEOUT_MS,
    DEFAULT_HANGUP_CAUSE,
    MAX_TERMINATION_GRACE_MS,
    DEFAULT_MAX_CALL_DURATION_MS,
} = require('../channel-lifecycle')

const EARLY_MEDIA_CAPTURE = [
    { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'efeff1bb-dc49-4e8f-9218-d84e255be8ed', 'Answer-State': 'ringing', 'Caller-Destination-Number': '5556', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5556-a' },
    { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': '44d43544-95eb-440f-84a6-aafdc63f515f', 'Answer-State': 'ringing', 'Caller-Destination-Number': '5556', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5556-b' },
    { 'Event-Name': 'CHANNEL_PROGRESS_MEDIA', 'Unique-ID': 'efeff1bb-dc49-4e8f-9218-d84e255be8ed', 'Answer-State': 'early', 'Caller-Destination-Number': '5556', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5556-a' },
    { 'Event-Name': 'CHANNEL_PROGRESS_MEDIA', 'Unique-ID': '44d43544-95eb-440f-84a6-aafdc63f515f', 'Answer-State': 'early', 'Caller-Destination-Number': '5556', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5556-b' },
    { 'Event-Name': 'CHANNEL_PARK', 'Unique-ID': 'efeff1bb-dc49-4e8f-9218-d84e255be8ed', 'Answer-State': 'early', 'Caller-Destination-Number': '9999', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5556-a' },
    { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': 'efeff1bb-dc49-4e8f-9218-d84e255be8ed', 'Answer-State': 'answered', 'Caller-Destination-Number': '9999', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5556-a' },
    { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': '44d43544-95eb-440f-84a6-aafdc63f515f', 'Answer-State': 'answered', 'Caller-Destination-Number': '5556', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5556-b' },
    { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': 'efeff1bb-dc49-4e8f-9218-d84e255be8ed', 'Answer-State': 'hangup', 'Caller-Destination-Number': '9999', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5556-a' },
    { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': '44d43544-95eb-440f-84a6-aafdc63f515f', 'Answer-State': 'hangup', 'Caller-Destination-Number': '5556', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5556-b' },
]

const NO_EARLY_MEDIA_CAPTURE = [
    { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': '04c5af22-8c97-46b1-a8e7-8fdde8bd9ad9', 'Answer-State': 'ringing', 'Caller-Destination-Number': '5557', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5557-a' },
    { 'Event-Name': 'CHANNEL_CREATE', 'Unique-ID': 'c85fd2a8-c694-43c5-936a-92841834fcae', 'Answer-State': 'ringing', 'Caller-Destination-Number': '5557', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5557-b' },
    { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': '04c5af22-8c97-46b1-a8e7-8fdde8bd9ad9', 'Answer-State': 'answered', 'Caller-Destination-Number': '5557', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5557-a' },
    { 'Event-Name': 'CHANNEL_ANSWER', 'Unique-ID': 'c85fd2a8-c694-43c5-936a-92841834fcae', 'Answer-State': 'answered', 'Caller-Destination-Number': '5557', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5557-b' },
    { 'Event-Name': 'CHANNEL_PARK', 'Unique-ID': '04c5af22-8c97-46b1-a8e7-8fdde8bd9ad9', 'Answer-State': 'answered', 'Caller-Destination-Number': '9999', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5557-a' },
    { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': '04c5af22-8c97-46b1-a8e7-8fdde8bd9ad9', 'Answer-State': 'hangup', 'Caller-Destination-Number': '9999', 'Call-Direction': 'outbound', 'Channel-Name': 'loopback/5557-a' },
    { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': 'c85fd2a8-c694-43c5-936a-92841834fcae', 'Answer-State': 'hangup', 'Caller-Destination-Number': '5557', 'Call-Direction': 'inbound', 'Channel-Name': 'loopback/5557-b' },
]

const EARLY_A = 'efeff1bb-dc49-4e8f-9218-d84e255be8ed'
const EARLY_B = '44d43544-95eb-440f-84a6-aafdc63f515f'
const NOEARLY_A = '04c5af22-8c97-46b1-a8e7-8fdde8bd9ad9'
const NOEARLY_B = 'c85fd2a8-c694-43c5-936a-92841834fcae'
const X = '11111111-2222-4333-8444-555555555555'
const FORK_URL = 'ws://127.0.0.1:3030/audio'

// ---- Helpers --------------------------------------------------------------

function harness({ eslReply = async () => '+OK Success', mixType = 'mono', maxCallDurationMs } = {}) {
    const calls = { esl: [], ensure: [], forkFailures: [], termination: [] }
    // Per-command replies a test can set, e.g. a uuid_dump that reports the answer
    // instant. Falls through to `eslReply` for anything not set.
    const eslReplies = new Map()
    const logs = { info: [], error: [] }
    const timers = []
    const sessions = new Map()
    const lifecycle = createChannelLifecycle({
        autoForkExtensions: ['9999', '9998'],
        forkWsUrl: FORK_URL,
        mixType,
        eslApi: cmd => {
            calls.esl.push(cmd)
            for (const [prefix, reply] of eslReplies) {
                if (cmd.startsWith(prefix)) return Promise.resolve(reply)
            }
            return eslReply(cmd)
        },
        ensureSession: (uuid, isDead) => { calls.ensure.push({ uuid, isDead }); return Promise.resolve(null) },
        getSession: uuid => sessions.get(uuid),
        log: msg => logs.info.push(msg),
        logError: msg => logs.error.push(msg),
        onForkFailure: (uuid, reason) => calls.forkFailures.push({ uuid, reason }),
        onTerminationEvent: (kind, detail) => calls.termination.push({ kind, ...detail }),
        // Left at the production default unless a test needs to tell the cap timer
        // apart from another timer of the same length.
        ...(maxCallDurationMs === undefined ? {} : { maxCallDurationMs }),
        setTimer: (fn, ms) => {
            const t = { ms, cleared: false, fired: false, unref() {} }
            t.fn = () => { t.fired = true; fn() }
            timers.push(t)
            return t
        },
        clearTimer: t => { t.cleared = true },
    })
    const forks = () => calls.esl.filter(c => c.startsWith('uuid_audio_fork '))
    const broadcasts = () => calls.esl.filter(c => c.startsWith('uuid_broadcast '))
    const kills = () => calls.esl.filter(c => c.startsWith('uuid_kill '))
    const terminationKinds = () => calls.termination.map(e => e.kind)
    const liveTimers = ms => timers.filter(t => t.ms === ms && !t.cleared && !t.fired)
    return { lifecycle, calls, logs, timers, liveTimers, sessions, forks, broadcasts, kills, terminationKinds, eslReplies }
}

function ev(name, uuid, dest, answerState) {
    const h = { 'Event-Name': name, 'Unique-ID': uuid, 'Caller-Destination-Number': dest }
    if (answerState !== undefined) h['Answer-State'] = answerState
    return h
}

const tick = () => new Promise(resolve => setImmediate(resolve))

function fakeSession() {
    return {
        stopCount: 0,
        stopReasons: [],
        stop(reason) { this.stopCount++; this.stopReasons.push(reason) },
    }
}

// ---- Captured FreeSWITCH sequences ----------------------------------------

test('early media capture: exactly one fork, on CHANNEL_ANSWER, after the queued greeting is flushed', async () => {
    const h = harness()
    let greeting
    for (const e of EARLY_MEDIA_CAPTURE) {
        h.lifecycle.handleEvent(e)
        if (e['Event-Name'] === 'CHANNEL_PARK') {
            // CallSession synthesises during ringing and queues its greeting.
            greeting = h.lifecycle.playOrQueue(EARLY_A, '/tts/greeting.wav', 1200)
            await tick()
            assert.equal(h.broadcasts().length, 0, 'no playback before answer')
            assert.equal(h.forks().length, 0, 'no fork before answer')
        }
        if (e['Event-Name'] === 'CHANNEL_ANSWER' && e['Unique-ID'] === EARLY_A) {
            assert.equal(await greeting, 1200, 'queued greeting resolves with its duration on answer')
            await tick()
        }
    }
    assert.deepEqual(h.forks(), [
        `uuid_audio_fork ${EARLY_A} start ${FORK_URL}?callUuid=${EARLY_A} mono 8000 callUuid=${EARLY_A}`,
    ])
    assert.equal(h.calls.esl.indexOf(`uuid_broadcast ${EARLY_A} /tts/greeting.wav aleg`), 0, 'greeting flushed before the fork')
    assert.equal(h.calls.ensure.length, 1, 'session bound once, on PARK')
    assert.equal(h.calls.ensure[0].uuid, EARLY_A)
    assert.ok(h.logs.info.some(l => l.includes(`auto-forking audio for ${EARLY_A}`) && l.includes('via CHANNEL_ANSWER')))
    assert.equal(h.forks().some(c => c.includes(EARLY_B)), false, 'callee leg never forked')
    assert.deepEqual(h.lifecycle.snapshot(), { answered: [], forked: [], bound: [], dead: [EARLY_A], pending: [], preAnswerTimers: [], terminating: [], killed: [], terminationTimers: [], maxDurationTimers: [], overdue: [] })
})

test('no early media capture: exactly one fork, on the already-answered CHANNEL_PARK', async () => {
    const h = harness()
    for (const e of NO_EARLY_MEDIA_CAPTURE) {
        h.lifecycle.handleEvent(e)
        if (e['Event-Name'] === 'CHANNEL_ANSWER' && e['Unique-ID'] === NOEARLY_A) {
            // The answer is emitted before the transfer: it must not create any state.
            assert.deepEqual(h.lifecycle.snapshot(), { answered: [], forked: [], bound: [], dead: [], pending: [], preAnswerTimers: [], terminating: [], killed: [], terminationTimers: [], maxDurationTimers: [], overdue: [] })
            assert.equal(h.calls.esl.length, 0)
            assert.equal(h.calls.ensure.length, 0)
        }
        if (e['Event-Name'] === 'CHANNEL_PARK') {
            await tick()
            // The greeting synthesised after this PARK plays immediately.
            assert.equal(await h.lifecycle.playOrQueue(NOEARLY_A, '/tts/greeting.wav', 900), 900)
        }
    }
    assert.deepEqual(h.forks(), [
        `uuid_audio_fork ${NOEARLY_A} start ${FORK_URL}?callUuid=${NOEARLY_A} mono 8000 callUuid=${NOEARLY_A}`,
    ])
    assert.equal(h.broadcasts().length, 1)
    assert.equal(h.calls.ensure.length, 1, 'session bound once, on PARK')
    assert.ok(h.logs.info.some(l => l.includes(`auto-forking audio for ${NOEARLY_A}`) && l.includes('via CHANNEL_PARK')))
    assert.equal(h.forks().some(c => c.includes(NOEARLY_B)), false, 'callee leg never forked')
})

test('negative control: the previous rule (fork only on a matched CHANNEL_ANSWER) never forks the no-early-media capture', () => {
    const legacyForks = NO_EARLY_MEDIA_CAPTURE.filter(e =>
        e['Event-Name'] === 'CHANNEL_ANSWER' && ['9999', '9998'].includes(e['Caller-Destination-Number']))
    assert.equal(legacyForks.length, 0)
    const legacyForksEarly = EARLY_MEDIA_CAPTURE.filter(e =>
        e['Event-Name'] === 'CHANNEL_ANSWER' && ['9999', '9998'].includes(e['Caller-Destination-Number']))
    assert.equal(legacyForksEarly.length, 1)
})

// ---- Ordering, duplicates and exactly-once ---------------------------------

test('fast answer: matched ANSWER before an answered PARK forks once', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    await tick()
    assert.equal(h.forks().length, 1)
    assert.equal(h.calls.ensure.length, 1)
})

test('an answered PARK followed by a late unmatched ANSWER for the same channel forks once', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '79990001122', 'answered'))
    await tick()
    assert.equal(h.forks().length, 1)
})

test('duplicate events never issue a second fork or replay a broadcast', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/a.wav', 500)
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    assert.equal(await queued, 500)
    await tick()
    assert.equal(h.forks().length, 1)
    assert.equal(h.broadcasts().filter(c => c.includes('/tts/a.wav')).length, 1)
})

test('a PARK that is not yet answered never forks', async () => {
    for (const answerState of ['early', 'ringing', 'hangup', undefined]) {
        const h = harness()
        h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', answerState))
        await tick()
        assert.equal(h.forks().length, 0, `Answer-State=${answerState}`)
        assert.equal(h.calls.ensure.length, 1, 'session binding still starts on PARK')
    }
})

// ---- Fork command -----------------------------------------------------------

test('fork command keeps the exact accepted grammar, including the sampling rate', () => {
    const cmd = buildAudioForkCommand(X, FORK_URL, 'mono')
    assert.equal(cmd, `uuid_audio_fork ${X} start ${FORK_URL}?callUuid=${X} mono 8000 callUuid=${X}`)
    const tokens = cmd.split(' ')
    assert.equal(tokens.length, 7)
    assert.equal(tokens[5], '8000', 'sampling rate is always sent (a 4-argument start crashed mod_audio_fork)')
})

test('invalid channel uuid or mix type is refused locally and never sent', async () => {
    assert.equal(buildAudioForkCommand('not-a-uuid', FORK_URL, 'mono'), null)
    assert.equal(buildAudioForkCommand(`${X} stop`, FORK_URL, 'mono'), null)
    assert.equal(buildAudioForkCommand(X, FORK_URL, 'quad'), null)
    assert.equal(buildAudioForkCommand(X, FORK_URL, ''), null)
    const bad = 'not-a-uuid'
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', bad, '9999', 'answered'))
    await tick()
    assert.equal(h.forks().length, 0)
    assert.equal(h.logs.error.filter(l => l.includes('auto-fork REFUSED')).length, 1)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', bad, '9999', 'answered'))
    await tick()
    assert.equal(h.logs.error.filter(l => l.includes('auto-fork REFUSED')).length, 1, 'refusal is not retried')
    assert.deepEqual(h.calls.forkFailures, [{ uuid: bad, reason: 'refused' }])
})

test('a misconfigured mix type stops the bridge from starting instead of making every call deaf', () => {
    for (const mixType of ['quad', '', 'MONO']) {
        assert.throws(() => harness({ mixType }), /invalid audio fork mix type/)
    }
    for (const mixType of ['mono', 'mixed', 'stereo']) {
        assert.doesNotThrow(() => harness({ mixType }))
    }
})

test('a rejected or failed fork is logged once and not retried', async () => {
    const rejected = harness({ eslReply: async cmd => (cmd.startsWith('uuid_audio_fork ') ? '-ERR Operation Failed' : '+OK') })
    rejected.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    rejected.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    await tick()
    assert.equal(rejected.forks().length, 1)
    assert.equal(rejected.logs.error.filter(l => l.includes('auto-fork REJECTED')).length, 1)
    assert.deepEqual(rejected.calls.forkFailures, [{ uuid: X, reason: 'rejected' }], 'the failure is reported once')

    const failed = harness({ eslReply: async () => { throw new Error('ESL timeout') } })
    failed.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    failed.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    assert.equal(failed.forks().length, 1)
    assert.equal(failed.logs.error.filter(l => l.includes('auto-fork FAILED')).length, 1)
    assert.deepEqual(failed.calls.forkFailures, [{ uuid: X, reason: 'failed' }], 'the failure is reported once')
})

// ---- Hangup and cleanup -----------------------------------------------------

test('an unanswered call that hangs up: queued playback resolves 0, session stopped, never forked', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/greeting.wav', 1200)
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    assert.equal(await queued, 0)
    assert.equal(session.stopCount, 1)
    assert.equal(h.forks().length, 0)
    assert.equal(h.broadcasts().length, 0)
    assert.deepEqual(h.lifecycle.snapshot(), { answered: [], forked: [], bound: [], dead: [X], pending: [], preAnswerTimers: [], terminating: [], killed: [], terminationTimers: [], maxDurationTimers: [], overdue: [] })
    assert.equal(await h.lifecycle.playOrQueue(X, '/tts/late.wav', 700), null, 'late playback is dropped')
    assert.equal(h.calls.esl.length, 0)
})

test('events delivered after hangup neither bind a session nor fork', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    assert.equal(h.forks().length, 0)
    assert.equal(h.calls.ensure.length, 1, 'only the PARK before hangup started a bind')
    assert.ok(h.lifecycle.isDead(X), 'a late PARK does not clear the dead mark')
})

test('dead channels are reaped after the TTL', () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    assert.equal(h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS).length, 0, 'the pre-answer timer is cleared on hangup')
    const reapers = h.liveTimers(DEFAULT_DEAD_CHANNEL_TTL_MS)
    assert.equal(reapers.length, 1)
    assert.ok(h.lifecycle.isDead(X))
    reapers[0].fn()
    assert.equal(h.lifecycle.isDead(X), false)
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    assert.equal(h.timers.filter(t => t.ms === DEFAULT_DEAD_CHANNEL_TTL_MS).length, 2)
})

test('a repeated PARK binds the CRM session only once per channel', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    await tick()
    assert.equal(h.calls.ensure.length, 1, 'one bind for the channel')
    assert.equal(h.forks().length, 1)
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    assert.deepEqual(h.lifecycle.snapshot().bound, [], 'the bind mark is released on hangup')
})

function dumpReply(state) {
    return async cmd => (cmd.startsWith('uuid_dump ') ? (state === null ? '-ERR No such channel!' : `Event-Name: CHANNEL_DATA\nAnswer-State: ${state}\nUnique-ID: ${X}\n`) : '+OK')
}

test('an unanswered channel that FreeSWITCH no longer has is released when its hangup event was lost', async () => {
    const h = harness({ eslReply: dumpReply(null) })
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/greeting.wav', 1200)
    const timers = h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)
    assert.equal(timers.length, 1, 'one pending answer-state check')
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    assert.equal(h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS).length, 1, 'a repeated PARK does not add a second check')

    timers[0].fn()
    await tick()
    assert.deepEqual(h.calls.esl, [`uuid_dump ${X}`], 'FreeSWITCH is asked, nothing else is sent')
    assert.equal(await queued, 0, 'queued playback resolves 0')
    assert.equal(session.stopCount, 1, 'the session is stopped and finalizes')
    assert.ok(h.lifecycle.isDead(X))

    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    assert.equal(h.forks().length, 0, 'a late answer after the release neither forks')
    assert.equal(h.broadcasts().length, 0, 'nor plays')
})

test('a channel still ringing past the check interval keeps waiting, however long it rings', async () => {
    const h = harness({ eslReply: dumpReply('early') })
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/greeting.wav', 1200)
    for (let round = 0; round < 3; round++) {
        const [timer] = h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)
        assert.ok(timer, `check ${round + 1} is armed`)
        timer.fn()
        await tick()
    }
    assert.equal(session.stopCount, 0, 'a ringing call is never released')
    assert.equal(h.lifecycle.isDead(X), false)
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    assert.equal(await queued, 1200, 'the greeting plays when the callee finally answers')
    await tick()
    assert.equal(h.forks().length, 1, 'and the call is forked once')
    assert.equal(h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS).length, 0, 'no check remains after answer')
})

test('an answered channel whose CHANNEL_ANSWER was lost gets its answer actions from the check', async () => {
    const h = harness({ eslReply: dumpReply('answered') })
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/greeting.wav', 1200)
    h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)[0].fn()
    await tick()
    assert.equal(await queued, 1200, 'the queued greeting is flushed')
    await tick()
    assert.equal(h.forks().length, 1, 'exactly one fork')
    assert.ok(h.logs.info.some(l => l.includes(`auto-forking audio for ${X}`) && l.includes('via uuid_dump')))
    assert.equal(session.stopCount, 0)
    assert.equal(h.lifecycle.isDead(X), false)
})

test('a failed answer-state check neither releases nor forks and is retried', async () => {
    const h = harness({ eslReply: async cmd => { if (cmd.startsWith('uuid_dump ')) throw new Error('ESL timeout'); return '+OK' } })
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)[0].fn()
    await tick()
    await tick()
    assert.equal(session.stopCount, 0)
    assert.equal(h.forks().length, 0)
    assert.equal(h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS).length, 1, 'the check is re-armed')
    assert.ok(h.logs.error.some(l => l.includes('answer-state check failed')))
})

test('answer before the pre-answer deadline cancels the wait', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const [timer] = h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()
    assert.equal(timer.cleared, true)
    assert.equal(h.forks().length, 1)
    timer.fn()
    assert.equal(session.stopCount, 0, 'a stale timer callback does not release an answered channel')
    assert.equal(h.lifecycle.isDead(X), false)
})

test('the bind sees a hangup that happens while it awaits the CRM', () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const { isDead } = h.calls.ensure[0]
    assert.equal(isDead(), false)
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    assert.equal(isDead(), true)
})

test('foreign channels create no state, timers or logs', () => {
    const h = harness()
    const other = '99999999-8888-4777-8666-555555555555'
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', other, '101', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', other, '101', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', other, '101', 'hangup'))
    h.lifecycle.handleEvent(ev('CHANNEL_EXECUTE', X, '9999', 'answered'))
    assert.equal(h.timers.length, 0)
    assert.equal(h.logs.info.length, 0)
    assert.equal(h.calls.esl.length, 0)
    assert.equal(h.lifecycle.isDead(other), false)
})

// ---- Physical termination -----------------------------------------------------
//
// The primitive that ends a channel. It is one-way on purpose: a session asks for
// termination, and this module never calls back into the session. The session's
// own finalize stays exactly-once because of its own terminal state, not because
// of anything here.

async function answered(h, uuid = X) {
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', uuid, '9999', 'answered'))
    await tick()
    return h
}

test('terminate on a live channel sends exactly one hangup and never touches the session', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)

    assert.equal(h.lifecycle.terminate(X, { reason: 'completed' }), 'issued')
    await tick()

    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`], 'one kill, default cause')
    assert.equal(session.stopCount, 0, 'the primitive is one-way: it does not stop the session')
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued'])
    // The whole payload, not a field at a time: these events are the operator
    // surface and must stay bounded to identifiers and a truncated reply.
    assert.deepEqual(h.calls.termination[0], {
        kind: 'armed', callUuid: X, reason: 'max_duration',
        maxCallDurationMs: DEFAULT_MAX_CALL_DURATION_MS,
        remainingMs: DEFAULT_MAX_CALL_DURATION_MS, answerSource: 'local_clock',
    })
    assert.deepEqual(h.calls.termination[1], {
        kind: 'requested', callUuid: X, reason: 'completed', cause: DEFAULT_HANGUP_CAUSE, graceMs: 0,
    })
    assert.deepEqual(h.calls.termination[2], {
        kind: 'issued', callUuid: X, reason: 'completed', cause: DEFAULT_HANGUP_CAUSE, graceMs: 0, reply: '+OK Success',
    })
    assert.ok(h.lifecycle.isTerminating(X), 'the channel is marked while its hangup is in flight')
    assert.deepEqual(h.lifecycle.snapshot().terminating, [X])
})

test('a duplicate terminate request issues no second hangup', async () => {
    const h = harness()
    await answered(h)

    assert.equal(h.lifecycle.terminate(X, { reason: 'completed' }), 'issued')
    assert.equal(h.lifecycle.terminate(X, { reason: 'closed' }), 'duplicate')
    assert.equal(h.lifecycle.terminate(X, { reason: 'closed', graceMs: 5000 }), 'duplicate')
    await tick()

    assert.equal(h.kills().length, 1, 'exactly one kill for three requests')
    assert.equal(h.timers.filter(t => t.ms === 5000).length, 0, 'a duplicate never arms a grace timer')
    // The suppressions are synchronous; `issued` waits for FreeSWITCH's reply.
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'suppressed', 'suppressed', 'issued'])
    assert.ok(h.lifecycle.isKilled(X), 'the hangup was sent, so nothing may send another')
})

test('terminate on a channel FreeSWITCH already hung up sends nothing', async () => {
    const h = harness()
    await answered(h)
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()

    assert.equal(h.lifecycle.terminate(X, { reason: 'closed' }), 'suppressed')
    await tick()

    assert.equal(h.kills().length, 0, 'zero ESL kills for a dead channel')
    assert.deepEqual(h.terminationKinds(), ['armed', 'suppressed'])
    assert.equal(h.calls.termination[1].detail, 'channel already hung up')
})

test('a grace defers the hangup by exactly the requested wait', async () => {
    const h = harness()
    await answered(h)

    assert.equal(h.lifecycle.terminate(X, { reason: 'completed', graceMs: 2400 }), 'scheduled')
    await tick()
    assert.equal(h.kills().length, 0, 'nothing is sent while the last phrase is still playing')
    const pending = h.liveTimers(2400)
    assert.equal(pending.length, 1, 'one grace timer, armed at the requested wait')
    assert.deepEqual(h.lifecycle.snapshot().terminationTimers, [X])

    pending[0].fn()
    await tick()
    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`])
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued'])
    assert.deepEqual(h.lifecycle.snapshot().terminationTimers, [], 'the timer state is cleaned up')
})

test('a real hangup during the grace cancels the deferred hangup', async () => {
    const h = harness()
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed', graceMs: 2400 })
    await tick()

    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()

    assert.equal(h.liveTimers(2400).length, 0, 'the grace timer is cleared by the real hangup')
    assert.equal(h.kills().length, 0, 'the lead hung up first, so nothing is sent')
    assert.equal(h.lifecycle.isTerminating(X), false, 'the mark is released with the channel')
})

test('an implausible grace is clamped instead of deferring the hangup indefinitely', async () => {
    const h = harness()
    await answered(h)

    h.lifecycle.terminate(X, { reason: 'completed', graceMs: 45 * 60 * 1000 })
    await tick()

    assert.equal(h.liveTimers(MAX_TERMINATION_GRACE_MS).length, 1, 'clamped to the bound')
    assert.equal(h.calls.termination[1].graceMs, MAX_TERMINATION_GRACE_MS, 'the event reports the clamped wait')
})

test('a channel FreeSWITCH says is already gone is a suppression, not a failure', async () => {
    // The ordinary ending: the lead hangs up, the fork WebSocket closes and stops
    // the session over one socket while CHANNEL_HANGUP_COMPLETE is still in flight
    // over another, so the kill arrives after the channel is gone. Reporting that
    // as an error would make the failure signal meaningless.
    const h = harness({ eslReply: async cmd => (cmd.startsWith('uuid_kill ') ? '-ERR No such channel!' : '+OK Success') })
    await answered(h)

    h.lifecycle.terminate(X, { reason: 'closed' })
    await tick()

    assert.equal(h.kills().length, 1)
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'suppressed'])
    assert.equal(h.calls.termination[2].detail, 'channel already gone')
    assert.deepEqual(h.logs.error, [], 'a normal ending logs no error')
})

test('a rejected hangup is reported once and not retried', async () => {
    const h = harness({ eslReply: async cmd => (cmd.startsWith('uuid_kill ') ? '-ERR Operation not permitted' : '+OK Success') })
    await answered(h)

    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()

    assert.equal(h.kills().length, 1, 'no retry storm: one attempt only')
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'failed'])
    assert.equal(h.calls.termination[2].detail, '-ERR Operation not permitted')
    assert.equal(h.logs.error.filter(m => m.includes('termination REJECTED')).length, 1)
    // Not even a deferred retry: the failure path arms nothing, and firing
    // whatever it might have armed produces no second command. The hard duration
    // cap is excluded on purpose — it is a backstop, not a retry, and it has its
    // own test below.
    const retryTimers = h.timers.filter(t => !t.cleared && !t.fired && t.ms !== DEFAULT_MAX_CALL_DURATION_MS)
    assert.deepEqual(retryTimers, [], 'the failure path arms no timer at all')
    for (const t of retryTimers) t.fn()
    await tick()
    assert.equal(h.kills().length, 1, 'no timer-based retry either')
    // The channel may still be up. A later independent safety trigger has to be
    // able to act on it — one transient ESL failure must not produce a call that
    // nothing can ever end. Still one attempt per trigger, so still no loop.
    assert.equal(h.lifecycle.isTerminating(X), false, 'a rejected attempt releases the mark')
    assert.equal(h.lifecycle.terminate(X, { reason: 'max_duration' }), 'issued', 'a later trigger may try again')
    await tick()
    assert.equal(h.kills().length, 2, 'exactly one attempt per independent trigger')
})

test('a terminating mark does not outlive a lost hangup event', async (t) => {
    // The cap and the dead-channel TTL are both ten minutes in production, so this
    // test gives the cap a distinct length to keep the timer lookup unambiguous.
    const h = harness({ maxCallDurationMs: 7 * 60 * 1000 })
    await answered(h)

    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.ok(h.lifecycle.isTerminating(X), 'marked while FreeSWITCH works on the kill')

    // FreeSWITCH accepted the kill but its CHANNEL_HANGUP_COMPLETE never arrived
    // (an event-socket reconnect can lose one), so the mark expires on its own.
    const expiry = h.liveTimers(DEFAULT_DEAD_CHANNEL_TTL_MS)
    assert.equal(expiry.length, 1, 'the mark is bounded by the same TTL as the dead set')
    expiry[0].fn()
    assert.equal(h.lifecycle.isTerminating(X), false, 'the state converges instead of growing')
    assert.equal(h.kills().length, 1, 'expiry sends nothing by itself')
})

test('a hangup event that does arrive releases the mark immediately', async (t) => {
    const h = harness({ maxCallDurationMs: 7 * 60 * 1000 })
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()

    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))

    assert.equal(h.lifecycle.isTerminating(X), false)
    assert.equal(h.liveTimers(DEFAULT_DEAD_CHANNEL_TTL_MS).filter(t => !t.cleared).length, 1,
        'only the dead-channel reaper is left running')
})

test('a failing ESL transport is reported once and not retried', async () => {
    const h = harness({
        eslReply: async cmd => {
            if (cmd.startsWith('uuid_kill ')) throw new Error('esl timeout after 5000ms (stage=sending)')
            return '+OK Success'
        },
    })
    await answered(h)

    h.lifecycle.terminate(X, { reason: 'closed' })
    await tick()

    assert.equal(h.kills().length, 1)
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'failed'])
    assert.match(h.calls.termination[2].detail, /esl timeout/)
})

test('terminate refuses inputs that must never reach an ESL command line', async () => {
    const h = harness()
    await answered(h)

    assert.equal(h.lifecycle.terminate('not-a-uuid', { reason: 'completed' }), 'refused')
    assert.equal(h.lifecycle.terminate(X, { reason: 'completed', cause: 'NORMAL_CLEARING; uuid_kill all' }), 'refused')
    await tick()

    assert.equal(h.kills().length, 0, 'nothing is sent for a refused request')
    assert.deepEqual(h.terminationKinds(), ['armed', 'failed', 'failed'])
    assert.equal(h.lifecycle.isTerminating(X), false, 'a refused request leaves no mark')
})

test('the hangup this bridge sends still drives the existing CHANNEL_HANGUP_COMPLETE path', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    const queued = h.lifecycle.playOrQueue(X, '/tts/goodbye.wav', 1800)
    await tick()

    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.equal(session.stopCount, 0, 'the kill alone does not end the session')

    // FreeSWITCH answers our kill with the same event a lead hangup produces, and
    // that is what the CRM turns into recording processing. Nothing about that
    // path changes: the bridge sends only the kill, never a fork stop.
    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()

    assert.equal(session.stopCount, 1, 'the release path still stops the session exactly once')
    assert.ok(h.lifecycle.isDead(X))
    assert.equal(await queued, 0, 'an unplayed queued phrase still resolves so _speak can fall through')
    assert.deepEqual(h.calls.esl.filter(c => c.includes('uuid_audio_fork')), [], 'no fork stop is issued')
    assert.equal(h.kills().length, 1)
})

// ---- Hard maximum call duration -----------------------------------------------
//
// The backstop above every other ending. Nothing else in the bridge bounds a call:
// the dialplan parks the leg with no exit, the silence strikes only end the dialog,
// and a channel whose CRM bind 404'd has no session at all. Ten minutes from the
// answer fact, cut immediately, whatever the dialog is doing.

function capTimers(h) {
    return h.liveTimers(DEFAULT_MAX_CALL_DURATION_MS)
}

test('the cap is ten minutes of answered call', () => {
    assert.equal(DEFAULT_MAX_CALL_DURATION_MS, 10 * 60 * 1000)
})

test('an answered channel is capped, and the deadline ends it immediately', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)

    const cap = capTimers(h)
    assert.equal(cap.length, 1, 'armed once on the answer fact')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [X])
    assert.equal(h.kills().length, 0, 'nothing happens before the deadline')

    cap[0].fn()
    await tick()

    // Two independent actions, neither nested in the other.
    assert.deepEqual(session.stopReasons, ['max_duration'], 'the session ends with the cap reason')
    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`], 'exactly one immediate hangup')
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued'])
    assert.equal(h.calls.termination[1].reason, 'max_duration')
    assert.equal(h.calls.termination[1].graceMs, 0, 'no grace: the cap is the hard stop')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [], 'the cap timer is consumed')
})

test('the cap is armed exactly once across repeated ANSWER and PARK events', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'answered'))
    h.lifecycle.handleEvent(ev('CHANNEL_ANSWER', X, '9999', 'answered'))
    await tick()

    assert.equal(capTimers(h).length, 1, 'one cap timer for four answer-bearing events')
    assert.equal(h.terminationKinds().filter(k => k === 'armed').length, 1, 'one armed event')
})

test('both captured production event orders arm exactly one cap', async () => {
    for (const [capture, uuid] of [[EARLY_MEDIA_CAPTURE, EARLY_A], [NO_EARLY_MEDIA_CAPTURE, NOEARLY_A]]) {
        const h = harness()
        for (const e of capture) {
            if (e['Event-Name'] === 'CHANNEL_HANGUP_COMPLETE') break
            h.lifecycle.handleEvent(e)
        }
        await tick()
        assert.equal(capTimers(h).length, 1, `one cap timer for ${uuid}`)
        assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [uuid])
    }
})

test('a channel that is never answered is never capped', async () => {
    const h = harness()
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    await tick()

    assert.equal(capTimers(h).length, 0, 'ringing is not answered time')
    assert.equal(h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS).length, 1, 'only the pre-answer re-check is armed')
    assert.deepEqual(h.terminationKinds(), [], 'nothing is armed and nothing is requested')
})

test('a remote hangup before the deadline cancels the cap', async () => {
    const h = harness()
    await answered(h)
    const cap = capTimers(h)
    assert.equal(cap.length, 1)

    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()

    // Asserted on the handle and the snapshot, not by length: the dead-channel
    // reaper this hangup arms happens to have the same ten-minute period as the cap.
    assert.equal(cap[0].cleared, true, 'the cap timer is cleared with the channel')
    assert.equal(cap[0].fired, false, 'and never fires')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [])
    assert.equal(h.kills().length, 0, 'the lead ended the call, so the bridge sends nothing')
})

test('a capped channel with no CallSession is still killed', async () => {
    // The CRM lookup answers 404 for an ad-hoc call, so no session is ever bound.
    // This is the case nothing else in the bridge can end.
    const h = harness()
    await answered(h)
    assert.equal(h.sessions.size, 0, 'no session was bound')

    capTimers(h)[0].fn()
    await tick()

    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`])
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued'])
})

test('the deadline does not care what the dialog was doing', async () => {
    // listening, an LLM round-trip, a synthesis and an active playback are all just
    // "the session has not ended yet" from the channel's point of view: the cap
    // stops the session and the channel either way. The session-side proof that a
    // late LLM/TTS/STT cannot resurrect anything lives in silence-timer.test.js.
    for (const phase of ['listening', 'thinking', 'speaking', 'playback']) {
        const h = harness()
        const session = fakeSession()
        h.sessions.set(X, session)
        await answered(h)
        if (phase === 'playback') {
            const playing = h.lifecycle.playOrQueue(X, '/tts/answer.wav', 4000)
            await tick()
            assert.equal(h.broadcasts().length, 1, 'the phrase is on the wire')
            assert.equal(await playing, 4000)
        }

        capTimers(h)[0].fn()
        await tick()

        assert.deepEqual(session.stopReasons, ['max_duration'], `${phase}: session stopped with the cap reason`)
        assert.equal(h.kills().length, 1, `${phase}: exactly one hangup`)
    }
})

test('the cap preempts a goodbye grace: one hangup, sent immediately', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)

    // The bot said goodbye, so a kill is scheduled behind the remaining playback.
    assert.equal(h.lifecycle.terminate(X, { reason: 'completed', graceMs: 5000 }), 'scheduled')
    await tick()
    const grace = h.liveTimers(5000)
    assert.equal(grace.length, 1)
    assert.equal(h.kills().length, 0)

    // The cap expires first.
    capTimers(h)[0].fn()
    await tick()

    assert.equal(grace[0].cleared, true, 'the pending grace is cancelled, not fired')
    assert.equal(grace[0].fired, false)
    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`], 'one hangup in total')
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'escalated', 'issued'])
    assert.deepEqual(h.calls.termination[2], {
        kind: 'escalated',
        callUuid: X,
        reason: 'max_duration',
        cause: DEFAULT_HANGUP_CAUSE,
        graceMs: 0,
        preempted_reason: 'completed',
        preempted_grace_ms: 5000,
    })
    assert.deepEqual(h.lifecycle.snapshot().terminationTimers, [], 'no wait is left behind')
})

test('a request that wants a grace never preempts a pending one', async () => {
    const h = harness()
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed', graceMs: 5000 })
    await tick()

    assert.equal(h.lifecycle.terminate(X, { reason: 'completed', graceMs: 1000 }), 'duplicate')
    await tick()

    assert.equal(h.kills().length, 0, 'still waiting for the first grace')
    assert.equal(h.liveTimers(5000).length, 1, 'the original wait is untouched')
    assert.equal(h.liveTimers(1000).length, 0, 'and no second wait was armed')
})

test('the cap after a hangup already sent adds no second hangup', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.equal(h.kills().length, 1)

    capTimers(h)[0].fn()
    await tick()

    assert.equal(h.kills().length, 1, 'at most one hangup per episode')
    // The deadline found the hangup already sent, so it adds nothing — and records
    // that this channel is now past its deadline while still up.
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued', 'suppressed', 'overdue'])
    assert.equal(h.calls.termination[3].detail, 'hangup already sent')
    assert.equal(h.lifecycle.isOverdue(X), true)
})

test('the cap after a real hangup sends nothing at all', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)
    const cap = capTimers(h)

    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()
    // The event cleared the timer; firing the stale handle anyway proves the
    // deadline itself is harmless on a dead channel.
    cap[0].fn()
    await tick()

    assert.equal(h.kills().length, 0)
    assert.equal(h.terminationKinds().at(-1), 'suppressed')
    assert.equal(h.calls.termination.at(-1).detail, 'channel already hung up')
})

test('a duplicate cap callback produces no duplicate side effects', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    await answered(h)
    const cap = capTimers(h)

    cap[0].fn()
    cap[0].fn()
    await tick()

    assert.equal(h.kills().length, 1, 'one hangup')
    assert.deepEqual(session.stopReasons, ['max_duration', 'max_duration'],
        'stop() is idempotent in the session and is asserted there; the channel side stays single')
    assert.equal(h.terminationKinds().filter(k => k === 'requested').length, 1)
})

test('a session whose finalize throws does not stop the channel from being cut', async () => {
    const h = harness()
    h.sessions.set(X, { stopReasons: [], stop(reason) { this.stopReasons.push(reason); throw new Error('CRM unreachable') } })
    await answered(h)

    capTimers(h)[0].fn()
    await tick()

    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`], 'the safety action still runs')
    assert.equal(h.logs.error.filter(m => m.includes('session stop failed')).length, 1, 'and the failure is visible')
})

test('a failed cap hangup is not retried, and the channel keeps no stale mark', async () => {
    const h = harness({ eslReply: async cmd => (cmd.startsWith('uuid_kill ') ? '-ERR Operation not permitted' : '+OK Success') })
    await answered(h)

    capTimers(h)[0].fn()
    await tick()

    assert.equal(h.kills().length, 1, 'one attempt, no retry loop')
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'failed', 'overdue'])
    assert.equal(h.lifecycle.isKilled(X), false, 'the episode is released')
    assert.equal(h.lifecycle.isTerminating(X), false)
    // The deadline has passed, so the channel is overdue and stays that way. It is
    // NOT given another ten minutes, and nothing is re-armed to try again.
    assert.equal(h.lifecycle.isOverdue(X), true)
    assert.deepEqual(capTimers(h), [], 'no new window')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [])
    assert.equal(h.kills().length, 1, 'and no further command is ever sent')
})

test('a cap spent while an earlier hangup is still in flight does not buy more time', async () => {
    // The bot's goodbye kill is sent at 9:59 and the ESL reply is still pending when
    // the deadline arrives. The deadline correctly sends nothing — one command while
    // one is outstanding — and the channel becomes overdue. When that kill then fails
    // the channel is still overdue: no second ten-minute window, no retry.
    let settle = null
    const h = harness({
        eslReply: cmd => (cmd.startsWith('uuid_kill ')
            ? new Promise((_, reject) => { settle = () => reject(new Error('esl timeout after 5000ms (stage=sending)')) })
            : Promise.resolve('+OK Success')),
    })
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.equal(h.kills().length, 1, 'the goodbye kill is out but unanswered')

    capTimers(h)[0].fn()
    await tick()
    assert.equal(h.kills().length, 1, 'the deadline adds no second command while one is in flight')
    assert.equal(h.lifecycle.isOverdue(X), true, 'and the channel is overdue from that moment')
    assert.equal(h.calls.termination.at(-1).kind, 'overdue')
    assert.equal(h.calls.termination.at(-1).detail, 'hangup already outstanding at the deadline')

    settle()
    await tick()
    assert.deepEqual(capTimers(h), [], 'the failure grants no new window')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [])
    assert.equal(h.kills().length, 1, 'and sends nothing further')
    assert.equal(h.terminationKinds().filter(k => k === 'armed').length, 1, 'armed exactly once, ever')
})

test('a hangup that lands leaves no cap behind', async () => {
    const h = harness()
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'issued'])
    assert.equal(h.terminationKinds().filter(k => k === 'armed').length, 1, 'a successful hangup re-arms nothing')

    h.lifecycle.handleEvent(ev('CHANNEL_HANGUP_COMPLETE', X, '9999', 'hangup'))
    await tick()
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [], 'and the channel takes its cap with it')
})

test('an unusable cap duration stops the bridge instead of removing the cap', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
        assert.throws(() => harness({ maxCallDurationMs: bad }), /invalid max call duration/)
    }
})

test('the cap is the backstop for a hangup that failed', async () => {
    // The end_call kill failed on the transport, so the channel may still be up.
    // The cap is what guarantees it does not stay up forever.
    let replies = 0
    const h = harness({
        eslReply: async cmd => {
            if (!cmd.startsWith('uuid_kill ')) return '+OK Success'
            replies += 1
            if (replies === 1) throw new Error('esl timeout after 5000ms (stage=sending)')
            return '+OK Success'
        },
        maxCallDurationMs: 7 * 60 * 1000,
    })
    await answered(h)
    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.equal(h.kills().length, 1)
    assert.deepEqual(h.terminationKinds(), ['armed', 'requested', 'failed'])

    h.liveTimers(7 * 60 * 1000)[0].fn()
    await tick()

    assert.equal(h.kills().length, 2, 'the cap tries once more — one attempt per trigger, not a loop')
    assert.equal(h.terminationKinds().at(-1), 'issued')
})

// ---- Absolute answer deadline -------------------------------------------------
//
// The cap is ten minutes of ANSWERED CALL, measured from the instant FreeSWITCH
// answered the channel — not from the moment this bridge noticed. A lost
// CHANNEL_ANSWER discovered later by the pre-answer re-check must not buy the call
// another re-check interval, and no failure may ever move the deadline.

const { parseAnswerEpochMs } = require('../channel-lifecycle')

function answeredAgo(ms, now = Date.now()) {
    // `Caller-Channel-Answered-Time` is microseconds since the epoch; a uuid_dump
    // carries the same header because mod_commands serialises the channel with the
    // same event-data builder that stamps events.
    return String((now - ms) * 1000)
}

test('the answer instant is read from the headers FreeSWITCH stamps, and junk is ignored', () => {
    const now = 1_800_000_000_000
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': String((now - 5000) * 1000) }, now), now - 5000)
    assert.equal(parseAnswerEpochMs({ variable_answer_uepoch: String((now - 7000) * 1000) }, now), now - 7000)
    assert.equal(parseAnswerEpochMs({ variable_answer_epoch: String(Math.floor((now - 9000) / 1000)) }, now), now - 9000)
    // Preference order: the caller-profile header wins over the variables.
    assert.equal(parseAnswerEpochMs({
        'Caller-Channel-Answered-Time': String((now - 1000) * 1000),
        variable_answer_uepoch: String((now - 400_000) * 1000),
    }, now), now - 1000)
    // Nothing usable -> null, and the caller falls back to its own clock.
    assert.equal(parseAnswerEpochMs({}, now), null)
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': '0' }, now), null)
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': 'not-a-number' }, now), null)
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': '' }, now), null)
    // Implausible values are not answer times: far future, or older than a day.
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': String((now + 60_000) * 1000) }, now), null)
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': String((now - 48 * 3600_000) * 1000) }, now), null)
    // Ordinary clock skew is tolerated.
    assert.equal(parseAnswerEpochMs({ 'Caller-Channel-Answered-Time': String((now + 1000) * 1000) }, now), now + 1000)
})

test('the deadline is measured from the answer the channel reports, not from delivery', async () => {
    const h = harness()
    const headers = ev('CHANNEL_ANSWER', X, '9999', 'answered')
    headers['Caller-Channel-Answered-Time'] = answeredAgo(4 * 60 * 1000)
    h.lifecycle.handleEvent(headers)
    await tick()

    const armed = h.calls.termination[0]
    assert.equal(armed.kind, 'armed')
    assert.equal(armed.answerSource, 'channel', 'the channel told us when it answered')
    // Four minutes are already spent, so about six remain — never a fresh ten.
    assert.ok(armed.remainingMs <= 6 * 60 * 1000, `remaining ${armed.remainingMs} must not exceed what is left`)
    assert.ok(armed.remainingMs > 6 * 60 * 1000 - 5000, `remaining ${armed.remainingMs} must be about six minutes`)
    assert.equal(h.timers.filter(t => t.ms === armed.remainingMs).length, 1, 'the timer holds only the remainder')
})

test('a lost CHANNEL_ANSWER recovered by the re-check gets only the time the call has left', async () => {
    const h = harness()
    // Ringing park: the answer event is lost, so the pre-answer re-check is armed.
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    await tick()
    const recheck = h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)
    assert.equal(recheck.length, 1)
    assert.deepEqual(h.terminationKinds(), [], 'nothing is capped while it may still be ringing')

    // FreeSWITCH answers the dump: answered, and it happened eight minutes ago.
    h.eslReplies.set('uuid_dump', [
        'Event-Name: CHANNEL_DATA',
        `Unique-ID: ${X}`,
        'Answer-State: answered',
        `Caller-Channel-Answered-Time: ${answeredAgo(8 * 60 * 1000)}`,
    ].join('\n'))
    recheck[0].fn()
    await tick()
    await tick()

    const armed = h.calls.termination.find(e => e.kind === 'armed')
    assert.ok(armed, 'the recovery caps the channel')
    assert.equal(armed.answerSource, 'channel')
    assert.ok(armed.remainingMs <= 2 * 60 * 1000, `remaining ${armed.remainingMs}: eight of ten minutes are gone`)
    assert.ok(armed.remainingMs > 2 * 60 * 1000 - 5000, `remaining ${armed.remainingMs} must be about two minutes`)
    assert.equal(h.kills().length, 0, 'and it is not yet due')
})

test('a recovery after the deadline terminates at once', async () => {
    const h = harness()
    const session = fakeSession()
    h.sessions.set(X, session)
    h.lifecycle.handleEvent(ev('CHANNEL_PARK', X, '9999', 'early'))
    await tick()
    const recheck = h.liveTimers(DEFAULT_PRE_ANSWER_TIMEOUT_MS)

    // The channel answered eleven minutes ago and nobody knew: already overdue.
    h.eslReplies.set('uuid_dump', [
        'Event-Name: CHANNEL_DATA',
        `Unique-ID: ${X}`,
        'Answer-State: answered',
        `Caller-Channel-Answered-Time: ${answeredAgo(11 * 60 * 1000)}`,
    ].join('\n'))
    recheck[0].fn()
    await tick()
    await tick()

    const armed = h.calls.termination.find(e => e.kind === 'armed')
    assert.equal(armed.remainingMs, 0, 'no time left at all')
    const due = h.timers.filter(t => t.ms === 0 && !t.cleared)
    assert.equal(due.length, 1, 'the deadline is due immediately, not in ten minutes')
    due[0].fn()
    await tick()
    assert.deepEqual(session.stopReasons, ['max_duration'])
    assert.deepEqual(h.kills(), [`uuid_kill ${X} ${DEFAULT_HANGUP_CAUSE}`])
})

test('the deadline never moves, whatever arrives later', async () => {
    const h = harness()
    const first = ev('CHANNEL_PARK', X, '9999', 'answered')
    first['Caller-Channel-Answered-Time'] = answeredAgo(3 * 60 * 1000)
    h.lifecycle.handleEvent(first)
    await tick()
    const deadline = h.lifecycle.deadlineAt(X)
    assert.ok(deadline, 'a deadline exists')

    // A later answer-bearing event, with a later answer time, must not extend it.
    const later = ev('CHANNEL_ANSWER', X, '9999', 'answered')
    later['Caller-Channel-Answered-Time'] = answeredAgo(0)
    h.lifecycle.handleEvent(later)
    await tick()
    assert.equal(h.lifecycle.deadlineAt(X), deadline, 'the deadline is absolute')
    assert.equal(h.terminationKinds().filter(k => k === 'armed').length, 1, 'and armed exactly once')
})

test('a channel is overdue only after its deadline, and a pre-deadline failure just waits for it', async () => {
    // A goodbye kill fails at nine minutes. The deadline is still armed and holds the
    // remaining minute, so exactly one further attempt happens — at the deadline, not
    // ten minutes after the failure.
    let replies = 0
    const h = harness({
        eslReply: async cmd => {
            if (!cmd.startsWith('uuid_kill ')) return '+OK Success'
            replies += 1
            return replies === 1 ? '-ERR Operation not permitted' : '+OK Success'
        },
    })
    const headers = ev('CHANNEL_PARK', X, '9999', 'answered')
    headers['Caller-Channel-Answered-Time'] = answeredAgo(9 * 60 * 1000)
    h.lifecycle.handleEvent(headers)
    await tick()
    const armed = h.calls.termination[0]
    assert.ok(armed.remainingMs > 0 && armed.remainingMs <= 60 * 1000, 'about a minute left')

    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    assert.equal(h.kills().length, 1)
    assert.equal(h.lifecycle.isOverdue(X), false, 'not overdue yet: the deadline has not passed')
    const due = h.timers.filter(t => t.ms === armed.remainingMs && !t.cleared && !t.fired)
    assert.equal(due.length, 1, 'the original deadline is still the one armed')

    due[0].fn()
    await tick()
    assert.equal(h.kills().length, 2, 'exactly one further attempt, at the deadline')
    assert.deepEqual(h.lifecycle.snapshot().maxDurationTimers, [], 'and nothing is armed after it')
})

test('no path can send a third hangup for one channel', async () => {
    // Worst case chained: a pre-deadline attempt fails, the deadline attempt fails
    // too, and then every timer left in the harness is fired. Two commands, ever.
    const h = harness({ eslReply: async cmd => (cmd.startsWith('uuid_kill ') ? '-ERR Operation not permitted' : '+OK Success') })
    const headers = ev('CHANNEL_PARK', X, '9999', 'answered')
    headers['Caller-Channel-Answered-Time'] = answeredAgo(10 * 60 * 1000 - 1000)
    h.lifecycle.handleEvent(headers)
    await tick()

    h.lifecycle.terminate(X, { reason: 'completed' })
    await tick()
    for (const t of h.timers.filter(t => !t.cleared && !t.fired)) t.fn()
    await tick()
    for (const t of h.timers.filter(t => !t.cleared && !t.fired)) t.fn()
    await tick()

    assert.equal(h.kills().length, 2, 'one pre-deadline attempt, one at the deadline, nothing more')
    assert.equal(h.lifecycle.isOverdue(X), true)
    assert.equal(h.terminationKinds().filter(k => k === 'overdue').length, 1, 'said once, not per attempt')
})

// ---- Session correlation ------------------------------------------------------

test('session resolver keeps looking until the session is bound, then keeps it', () => {
    const map = new Map()
    const resolve = createSessionResolver(X, uuid => map.get(uuid))
    assert.equal(resolve(), null, 'pending while the CRM bind runs')
    assert.equal(resolve(), null)
    const session = fakeSession()
    map.set(X, session)
    assert.equal(resolve(), session, 'found on a later frame')
    map.delete(X)
    assert.equal(resolve(), session, 'a session that finalized and left the map still gets stop() on close')
    assert.equal(createSessionResolver(null, () => session)(), null)
})

test('raw ESL event text is parsed and drives the lifecycle', async () => {
    const h = harness()
    const text = `Event-Name: CHANNEL_PARK\nUnique-ID: ${X}\nAnswer-State: answered\nCaller-Destination-Number: 9999\nChannel-Name: loopback/5557-a\n`
    const headers = parseEslEventHeaders(text)
    assert.equal(headers['Answer-State'], 'answered')
    h.lifecycle.handleEvent(headers)
    await tick()
    assert.equal(h.forks().length, 1)
})
