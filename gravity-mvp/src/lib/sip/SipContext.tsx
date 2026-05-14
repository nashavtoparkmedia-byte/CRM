"use client"

/**
 * SipProvider — wires JsSIP into a React context so the browser softphone
 * is available app-wide. Fetches SIP credentials from /api/calls/sip-credentials,
 * registers a user agent against the FreeSWITCH WS endpoint, and exposes a
 * minimal call control API + state for incoming popups & call toolbar.
 *
 * Notes:
 *  - Only renders / runs in the browser (use client). JsSIP is loaded via
 *    dynamic import so Next.js SSR doesn't choke on its `window` usage.
 *  - Plays remote audio through a hidden <audio> element appended to <body>.
 *  - Subscribes to /api/calls/stream so server-side events (calls picked up
 *    elsewhere, hangups, etc.) keep this context's state in sync.
 */

import React, { createContext, useContext, useEffect, useRef, useState } from 'react'

export type SipStatus = 'idle' | 'connecting' | 'registered' | 'unregistered' | 'failed'
export type CallState = 'ringing' | 'connecting' | 'active' | 'ended'

export interface IncomingCallInfo {
    callId: string | null            // Filled in once /api/calls/stream sees the matching event
    fromNumber: string
    displayName: string | null
    driverId: string | null
    contactId: string | null
    session: any                     // JsSIP RTCSession
}

export interface ActiveCallInfo {
    direction: 'inbound' | 'outbound'
    peerNumber: string
    displayName: string | null
    state: CallState
    startedAt: number
    answeredAt: number | null
    session: any
    isMuted: boolean
}

interface SipApi {
    status: SipStatus
    extension: string | null
    incomingCall: IncomingCallInfo | null
    activeCall: ActiveCallInfo | null
    call(phoneNumber: string): Promise<void>
    answer(): void
    decline(): void
    hangup(): void
    toggleMute(): void
}

const SipContext = createContext<SipApi | null>(null)

export function useSip(): SipApi {
    const ctx = useContext(SipContext)
    if (!ctx) throw new Error('useSip must be used inside SipProvider')
    return ctx
}

export function SipProvider({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<SipStatus>('idle')
    const [extension, setExtension] = useState<string | null>(null)
    const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null)
    const [activeCall, setActiveCall] = useState<ActiveCallInfo | null>(null)

    const uaRef = useRef<any>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)

    // --- Audio sink ---
    useEffect(() => {
        const el = document.createElement('audio')
        el.autoplay = true
        el.style.display = 'none'
        document.body.appendChild(el)
        audioRef.current = el
        return () => { el.remove() }
    }, [])

    // --- Register UA on mount ---
    useEffect(() => {
        let cancelled = false
        ;(async () => {
            setStatus('connecting')
            let creds: any
            try {
                const res = await fetch('/api/calls/sip-credentials', { cache: 'no-store' })
                if (!res.ok) { setStatus('failed'); return }
                creds = await res.json()
            } catch { setStatus('failed'); return }
            if (cancelled) return

            setExtension(creds.extension)

            // Turbopack sometimes wraps CJS in an ESM namespace with the real
            // module under .default, sometimes not — handle both shapes.
            const jssipModule = await import('jssip')
            const JsSIP: any = (jssipModule as any).default ?? jssipModule
            if (!JsSIP?.WebSocketInterface || !JsSIP?.UA) {
                console.error('[SIP] JsSIP module shape unexpected:', Object.keys(jssipModule), Object.keys(JsSIP ?? {}))
                setStatus('failed')
                return
            }
            // Dev-mode logging — comment out for production noise reduction.
            try { JsSIP.debug?.enable('JsSIP:*') } catch {}

            const socket = new JsSIP.WebSocketInterface(creds.wsUrl)
            const ua = new JsSIP.UA({
                uri: creds.sipUri,
                password: creds.password,
                authorization_user: creds.authUser,
                display_name: creds.displayName,
                sockets: [socket],
                register: true,
                session_timers: false,
            })

            ua.on('registered', () => { console.info('[SIP] registered'); setStatus('registered') })
            ua.on('unregistered', () => { console.info('[SIP] unregistered'); setStatus('unregistered') })
            ua.on('registrationFailed', (e: any) => { console.error('[SIP] registrationFailed', e?.cause, e); setStatus('failed') })
            ua.on('connecting', () => console.info('[SIP] ua connecting'))
            ua.on('connected', () => console.info('[SIP] ua connected'))
            ua.on('disconnected', (e: any) => console.warn('[SIP] ua disconnected', e?.code, e?.reason))

            ua.on('newRTCSession', (data: any) => {
                const session = data.session
                if (data.originator === 'remote') {
                    handleIncomingSession(session)
                } else {
                    handleOutgoingSession(session)
                }
            })

            uaRef.current = ua
            ua.start()
        })()

        return () => { cancelled = true; uaRef.current?.stop() }
    }, [])

    // --- Sync with server events ---
    useEffect(() => {
        const es = new EventSource('/api/calls/stream')
        es.onmessage = ev => {
            try {
                const data = JSON.parse(ev.data)
                if (data.type === 'incoming' && incomingCall && !incomingCall.callId) {
                    // Match the JsSIP-detected incoming with the DB call id
                    setIncomingCall(prev => prev ? { ...prev, callId: data.data.callId, driverId: data.data.driverId, contactId: data.data.contactId, displayName: prev.displayName ?? data.data.displayName } : prev)
                }
                if (data.type === 'ended' && activeCall) {
                    // Server confirmed end — clean local state if not already
                    setActiveCall(null)
                }
            } catch {}
        }
        return () => es.close()
    }, [incomingCall, activeCall])

    function attachRemoteAudio(session: any) {
        session.on('peerconnection', () => {
            const pc = session.connection
            pc.addEventListener('track', (ev: RTCTrackEvent) => {
                if (audioRef.current && ev.streams[0]) {
                    audioRef.current.srcObject = ev.streams[0]
                }
            })
        })
    }

    function handleIncomingSession(session: any) {
        attachRemoteAudio(session)
        const remoteId = session.remote_identity
        const fromNumber = remoteId?.uri?.user ?? 'unknown'
        const displayName = remoteId?.display_name ?? null

        setIncomingCall({
            callId: null,
            fromNumber,
            displayName,
            driverId: null,
            contactId: null,
            session,
        })

        session.on('ended', () => {
            setIncomingCall(prev => (prev?.session === session ? null : prev))
            setActiveCall(prev => (prev?.session === session ? null : prev))
        })
        session.on('failed', () => {
            setIncomingCall(prev => (prev?.session === session ? null : prev))
            setActiveCall(prev => (prev?.session === session ? null : prev))
        })
        session.on('accepted', () => {
            setIncomingCall(null)
            setActiveCall({
                direction: 'inbound',
                peerNumber: fromNumber,
                displayName,
                state: 'active',
                startedAt: Date.now(),
                answeredAt: Date.now(),
                session,
                isMuted: false,
            })
        })
    }

    function handleOutgoingSession(session: any) {
        attachRemoteAudio(session)
        const remoteId = session.remote_identity
        const peerNumber = remoteId?.uri?.user ?? 'unknown'
        const displayName = remoteId?.display_name ?? null

        setActiveCall({
            direction: 'outbound',
            peerNumber,
            displayName,
            state: 'connecting',
            startedAt: Date.now(),
            answeredAt: null,
            session,
            isMuted: false,
        })

        session.on('progress', () => {
            setActiveCall(prev => (prev?.session === session ? { ...prev, state: 'ringing' } : prev))
        })
        session.on('accepted', () => {
            setActiveCall(prev => (prev?.session === session ? { ...prev, state: 'active', answeredAt: Date.now() } : prev))
        })
        session.on('ended', () => {
            setActiveCall(prev => (prev?.session === session ? null : prev))
        })
        session.on('failed', () => {
            setActiveCall(prev => (prev?.session === session ? null : prev))
        })
    }

    async function call(phoneNumber: string) {
        const ua = uaRef.current
        if (!ua || status !== 'registered') throw new Error('SIP not registered')
        const digits = phoneNumber.replace(/\D/g, '')
        if (digits.length < 10) throw new Error('Invalid number')

        // Probe microphone *before* handing off to JsSIP so we can show a
        // useful message instead of a silent failure. JsSIP swallows
        // getUserMedia errors inside ua.call() without surfacing them to
        // the caller, which is how a permission-denied state hides as
        // "click did nothing".
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            stream.getTracks().forEach(t => t.stop())
        } catch (err: any) {
            const msg = err?.name === 'NotAllowedError'
                ? 'Браузер не дал доступ к микрофону. Разрешите его слева от адресной строки и попробуйте снова.'
                : err?.name === 'NotFoundError'
                    ? 'Микрофон не найден. Подключите устройство и обновите страницу.'
                    : `Не удалось получить доступ к микрофону: ${err?.message ?? err?.name ?? err}`
            console.error('[SIP] getUserMedia failed:', err)
            // Lazy-import sonner so SSR doesn't pull it in.
            try { (await import('sonner')).toast.error(msg) } catch {}
            throw new Error(msg)
        }

        const target = `sip:${digits}@crm.local`
        ua.call(target, {
            mediaConstraints: { audio: true, video: false },
            pcConfig: { iceServers: [] },
        })
    }

    function answer() {
        if (!incomingCall) return
        incomingCall.session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: [] } })
    }

    function decline() {
        if (!incomingCall) return
        incomingCall.session.terminate()
        setIncomingCall(null)
    }

    function hangup() {
        if (activeCall) activeCall.session.terminate()
        if (incomingCall) incomingCall.session.terminate()
    }

    function toggleMute() {
        if (!activeCall) return
        const session = activeCall.session
        if (activeCall.isMuted) {
            session.unmute({ audio: true })
        } else {
            session.mute({ audio: true })
        }
        setActiveCall({ ...activeCall, isMuted: !activeCall.isMuted })
    }

    return (
        <SipContext.Provider value={{ status, extension, incomingCall, activeCall, call, answer, decline, hangup, toggleMute }}>
            {children}
        </SipContext.Provider>
    )
}
