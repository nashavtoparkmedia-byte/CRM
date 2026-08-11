export type CallAlertAudioStatus = 'needs-interaction' | 'ready' | 'unsupported'

type StatusListener = (status: CallAlertAudioStatus) => void

export interface ActiveRingtone {
    stop(): void
}

let audioContext: AudioContext | null = null
let status: CallAlertAudioStatus = 'needs-interaction'
let enablePromise: Promise<CallAlertAudioStatus> | null = null
const listeners = new Set<StatusListener>()

function audioContextConstructor(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null
    return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null
}

function getOrCreateContext(): AudioContext | null {
    if (audioContext?.state === 'closed') audioContext = null
    if (audioContext) return audioContext

    const AudioContextClass = audioContextConstructor()
    if (!AudioContextClass) {
        setStatus('unsupported')
        return null
    }

    audioContext = new AudioContextClass()
    audioContext.addEventListener?.('statechange', syncStatusFromContext)
    syncStatusFromContext()
    return audioContext
}

function syncStatusFromContext() {
    if (!audioContext) return
    setStatus(audioContext.state === 'running' ? 'ready' : 'needs-interaction')
}

function setStatus(next: CallAlertAudioStatus) {
    if (status === next) return
    status = next
    for (const listener of listeners) listener(status)
}

export function getCallAlertAudioStatus(): CallAlertAudioStatus {
    if (!audioContextConstructor()) return 'unsupported'
    if (audioContext) syncStatusFromContext()
    return status
}

export function subscribeCallAlertAudioStatus(listener: StatusListener): () => void {
    listeners.add(listener)
    listener(getCallAlertAudioStatus())
    return () => { listeners.delete(listener) }
}

/**
 * Chrome only permits audible Web Audio after a user interaction with the
 * site. Call this from a click/key handler once per page load and keep the
 * same AudioContext alive for later server-pushed incoming calls.
 */
export async function enableCallAlertAudio(): Promise<CallAlertAudioStatus> {
    const ctx = getOrCreateContext()
    if (!ctx) return 'unsupported'
    if (ctx.state === 'running') {
        setStatus('ready')
        return 'ready'
    }

    if (enablePromise) return enablePromise
    enablePromise = (async () => {
        try {
            await ctx.resume()
        } catch (err) {
            console.warn('[SIP] call alert audio unlock failed:', err)
        }
        syncStatusFromContext()
        return status
    })().finally(() => { enablePromise = null })
    return enablePromise
}

/**
 * Starts the shared incoming-call ringtone. Returns null when the browser is
 * still blocking sound; the UI can then offer an explicit enable button.
 */
export async function startIncomingRingtone(): Promise<ActiveRingtone | null> {
    // Do not call resume() here: incoming events are not user gestures, and
    // Chrome may leave that promise pending until a later click. Creating the
    // context is still useful because browsers/origins with autoplay already
    // allowed will report `running` immediately.
    const ctx = getOrCreateContext()
    if (!ctx || ctx.state !== 'running') {
        syncStatusFromContext()
        return null
    }

    const gain = ctx.createGain()
    gain.gain.value = 0.08
    gain.connect(ctx.destination)

    const first = ctx.createOscillator()
    const second = ctx.createOscillator()
    first.type = 'sine'
    first.frequency.value = 440
    second.type = 'sine'
    second.frequency.value = 480
    first.connect(gain)
    second.connect(gain)
    first.start()
    second.start()

    let audible = true
    const pulse = window.setInterval(() => {
        audible = !audible
        gain.gain.value = audible ? 0.08 : 0
    }, 2000)
    let stopped = false

    return {
        stop() {
            if (stopped) return
            stopped = true
            window.clearInterval(pulse)
            try { first.stop() } catch {}
            try { second.stop() } catch {}
            try { gain.disconnect() } catch {}
        },
    }
}
