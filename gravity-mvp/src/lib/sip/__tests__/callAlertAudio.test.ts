import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeAudioParam {
    value = 0
}

class FakeGain {
    gain = new FakeAudioParam()
    connect = vi.fn()
    disconnect = vi.fn()
}

class FakeOscillator {
    type: OscillatorType = 'sine'
    frequency = new FakeAudioParam()
    connect = vi.fn()
    start = vi.fn()
    stop = vi.fn()
}

class FakeAudioContext {
    state: AudioContextState
    destination = {}
    gains: FakeGain[] = []
    oscillators: FakeOscillator[] = []
    private stateListeners: Array<() => void> = []

    constructor(initialState: AudioContextState) {
        this.state = initialState
    }

    addEventListener = vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
        if (event !== 'statechange') return
        this.stateListeners.push(() => {
            if (typeof listener === 'function') listener(new Event('statechange'))
            else listener.handleEvent(new Event('statechange'))
        })
    })

    resume = vi.fn(async () => {
        this.state = 'running'
        this.stateListeners.forEach(listener => listener())
    })

    createGain = vi.fn(() => {
        const gain = new FakeGain()
        this.gains.push(gain)
        return gain
    })

    createOscillator = vi.fn(() => {
        const oscillator = new FakeOscillator()
        this.oscillators.push(oscillator)
        return oscillator
    })
}

const originalAudioContext = window.AudioContext

function installAudioContext(initialState: AudioContextState): FakeAudioContext[] {
    const instances: FakeAudioContext[] = []
    class InstalledAudioContext extends FakeAudioContext {
        constructor() {
            super(initialState)
            instances.push(this)
        }
    }
    Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        value: InstalledAudioContext,
    })
    return instances
}

afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'AudioContext', {
        configurable: true,
        value: originalAudioContext,
    })
})

describe('call alert audio', () => {
    it('unlocks the shared context from an explicit user action', async () => {
        const contexts = installAudioContext('suspended')
        const audio = await import('../callAlertAudio')

        expect(audio.getCallAlertAudioStatus()).toBe('needs-interaction')
        await expect(audio.enableCallAlertAudio()).resolves.toBe('ready')
        expect(contexts).toHaveLength(1)
        expect(contexts[0].resume).toHaveBeenCalledOnce()
        expect(audio.getCallAlertAudioStatus()).toBe('ready')
    })

    it('does not try to bypass Chrome autoplay from a pushed call event', async () => {
        const contexts = installAudioContext('suspended')
        const audio = await import('../callAlertAudio')

        await expect(audio.startIncomingRingtone()).resolves.toBeNull()
        expect(contexts).toHaveLength(1)
        expect(contexts[0].resume).not.toHaveBeenCalled()
    })

    it('starts and stops both ringtone oscillators without closing the unlocked context', async () => {
        const contexts = installAudioContext('running')
        const audio = await import('../callAlertAudio')

        const ringtone = await audio.startIncomingRingtone()
        expect(ringtone).not.toBeNull()
        expect(contexts[0].oscillators).toHaveLength(2)
        expect(contexts[0].oscillators[0].start).toHaveBeenCalledOnce()
        expect(contexts[0].oscillators[1].start).toHaveBeenCalledOnce()

        ringtone?.stop()
        expect(contexts[0].oscillators[0].stop).toHaveBeenCalledOnce()
        expect(contexts[0].oscillators[1].stop).toHaveBeenCalledOnce()
        expect(contexts[0].state).toBe('running')
    })
})
