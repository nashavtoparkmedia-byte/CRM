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

// Codecs we keep in outbound SDP offers.
// Megafon SBC silently drops INVITEs whose first audio codec is opus (or anything
// it doesn't recognise), and FreeSWITCH bridges a-leg codecs to the b-leg, so
// opus from the browser ends up in the gateway INVITE and the call dies at 408.
// Restricting the browser offer to G.711 + DTMF keeps the b-leg compatible.
//
// Order matters: codecs are matched against this list in order, so PCMA must
// appear before PCMU. Megafon only offers PCMA (codec 8) on its b-leg, and FS
// picks the FIRST codec from the browser's m=audio line for the a-leg. If
// PCMU comes first the bridge gets PCMU↔PCMA and FS bails with
// "INCOMPATIBLE_DESTINATION" even though both legs are G.711.
const CODEC_PRIORITY = ['PCMA', 'PCMU', 'telephone-event', 'CN']
const KEEPABLE_CODEC = /^(PCMA|PCMU|telephone-event|CN)\//i

function transformSdpForMegafon(sdp: string): string {
    const lines = sdp.split(/\r?\n/)
    // pt → codec base name (e.g. "8" → "PCMA")
    const ptToCodec = new Map<string, string>()
    for (const line of lines) {
        const m = line.match(/^a=rtpmap:(\d+)\s+([^\/]+)\/.+$/i)
        if (m && KEEPABLE_CODEC.test(`${m[2]}/`)) ptToCodec.set(m[1], m[2])
    }
    if (ptToCodec.size === 0) return sdp

    const keepPts = new Set(ptToCodec.keys())

    const out: string[] = []
    for (const line of lines) {
        const mAudio = line.match(/^(m=audio\s+\d+\s+\S+)\s+(.+)$/)
        if (mAudio) {
            // Filter to allowed pts AND re-order so PCMA is the first match.
            const pts = mAudio[2]
                .split(/\s+/)
                .filter(pt => keepPts.has(pt))
                .sort((a, b) => {
                    const ai = CODEC_PRIORITY.indexOf(ptToCodec.get(a) ?? '')
                    const bi = CODEC_PRIORITY.indexOf(ptToCodec.get(b) ?? '')
                    return ai - bi
                })
            if (pts.length === 0) return sdp
            out.push(`${mAudio[1]} ${pts.join(' ')}`)
            continue
        }
        const ptAttr = line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/)
        if (ptAttr && !keepPts.has(ptAttr[1])) continue
        out.push(line)
    }
    return out.join('\r\n')
}

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
                    // Pass `data.request` explicitly — JsSIP 3.13 doesn't populate
                    // `session.request` synchronously at this point; the event
                    // payload is the only reliable place to read incoming headers.
                    handleIncomingSession(session, data.request)
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
            // Debug exposure for media diagnostics — getStats() probes
            // from devtools / automated tests. Safe to keep enabled because
            // exposing the PC object doesn't change any behaviour.
            ;(window as any).__lastPc = pc
            ;(window as any).__lastSession = session
            console.info('[SIP] peerconnection — exposed window.__lastPc / __lastSession')
            pc.addEventListener('track', (ev: RTCTrackEvent) => {
                const el = audioRef.current
                if (!el || !ev.streams[0]) return
                el.srcObject = ev.streams[0]
                console.info('[SIP] audio track attached', {
                    tracks: ev.streams[0].getAudioTracks().length,
                    muted: ev.streams[0].getAudioTracks()[0]?.muted,
                })
                // Explicit play() — Chrome's autoplay policy blocks silent
                // start when srcObject is assigned from a non-user-gesture
                // context (e.g. JsSIP `newRTCSession` event firing from a
                // WebSocket message). The `autoplay` attribute alone isn't
                // enough; we must invoke play() and catch the rejection.
                el.play()
                    .then(() => console.info('[SIP] remote audio playing'))
                    .catch(err => console.error('[SIP] audio.play() rejected:', err?.name, err?.message))
            })
        })
    }

    function handleIncomingSession(session: any, eventRequest?: any) {
        // Server-originated click-to-call routes through here too. /api/calls/originate
        // tells FS: "dial Megafon → when answered, bridge to user/<ext>". The bridge()
        // creates an outbound INVITE from FS to the browser, which JsSIP sees as a NEW
        // incoming session — same code path as a real Megafon inbound. To distinguish
        // them, EslClient.ts stamps P-CRM-Outbound-Bridge: true on the bridge dialstring.
        // When present: skip Accept/Decline popup, auto-answer, surface as outbound
        // ActiveCallPopup. Without this, the manager would click "Call" and immediately
        // get an "Incoming call" popup for their own outbound — very confusing.
        // Multiple ways to read the header — JsSIP versions vary in API
        const isOutboundBridge = (() => {
            try {
                // session.request is undefined inside the newRTCSession event in
                // JsSIP 3.13. Use the request from the event payload instead;
                // fall back to session.request for older flows.
                const req = eventRequest ?? session.request
                // Try every reasonable accessor in order
                const v1 = req?.getHeader?.('P-CRM-Outbound-Bridge')
                const v2 = req?.getHeader?.('p-crm-outbound-bridge')
                const v3 = req?.headers?.['P-CRM-Outbound-Bridge']
                const v4 = req?.headers?.['p-crm-outbound-bridge']
                // headers may be array of {raw} objects in some JsSIP versions
                const v5 = Array.isArray(req?.headers?.['P-CRM-Outbound-Bridge'])
                    ? req.headers['P-CRM-Outbound-Bridge'][0]?.raw
                    : undefined
                const probeJson = JSON.stringify({
                    v1: typeof v1 === 'string' ? v1 : (v1 ? 'truthy-nonstring' : null),
                    v2: typeof v2 === 'string' ? v2 : (v2 ? 'truthy-nonstring' : null),
                    v3: typeof v3 === 'string' ? v3 : (v3 ? 'truthy-nonstring' : null),
                    v4: typeof v4 === 'string' ? v4 : (v4 ? 'truthy-nonstring' : null),
                    v5,
                    hasRequest: !!req,
                    hasGetHeader: typeof req?.getHeader === 'function',
                    headerKeys: req?.headers ? Object.keys(req.headers) : null,
                    headersType: req?.headers ? typeof req.headers : null,
                    headersSample: req?.headers ? JSON.stringify(req.headers).slice(0, 500) : null,
                })
                console.info('[SIP] P-CRM probe JSON:', probeJson)
                const value = v1 || v2 || v3 || v4 || v5
                const str = typeof value === 'string' ? value : value?.raw ?? String(value ?? '')
                return /true/i.test(str.trim())
            } catch (err) {
                console.warn('[SIP] header probe threw', err)
                return false
            }
        })()

        attachRemoteAudio(session)
        const remoteId = session.remote_identity
        const fromNumber = remoteId?.uri?.user ?? 'unknown'
        const displayName = remoteId?.display_name ?? null

        if (isOutboundBridge) {
            console.info('[SIP] outbound-bridge callback detected — auto-answering', { fromNumber })
            setActiveCall({
                direction: 'outbound',
                peerNumber: fromNumber,
                displayName,
                state: 'connecting',
                startedAt: Date.now(),
                answeredAt: null,
                session,
                isMuted: false,
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
            try {
                session.answer({
                    mediaConstraints: { audio: true, video: false },
                    pcConfig: { iceServers: [] },
                })
            } catch (err: any) {
                console.error('[SIP] auto-answer threw:', err)
                setActiveCall(null)
                import('sonner').then(s => s.toast.error(`Не удалось ответить: ${err?.message ?? err}`)).catch(() => {})
            }
            return
        }

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
        // Strip opus (and any other non-G.711) from the local SDP offer before
        // JsSIP serialises the INVITE. JsSIP's _createLocalDescription resolves
        // with e.sdp from the 'sdp' event, so mutating data.sdp here propagates
        // to the wire. See node_modules/jssip/lib/RTCSession.js around line 1434.
        session.on('sdp', (data: any) => {
            if (data.originator !== 'local' || data.type !== 'offer') return
            const original = data.sdp as string
            const rewritten = transformSdpForMegafon(original)
            if (rewritten !== original) {
                data.sdp = rewritten
                console.info('[SIP] outbound SDP offer rewritten for Megafon', {
                    before: original.match(/^m=audio.*/m)?.[0],
                    after: rewritten.match(/^m=audio.*/m)?.[0],
                })
            }
        })

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

        // Hand straight to JsSIP. It calls getUserMedia internally; Chrome
        // surfaces the mic prompt because this runs inside a real user
        // gesture handler (button onClick). The pre-call probe we used to
        // have here interfered with the AudioContext flow elsewhere — the
        // outbound call sets up its own AudioContext per RTCSession.
        console.info('[SIP] call() → ua.call', { digits })
        const target = `sip:${digits}@crm.local`
        ua.call(target, {
            mediaConstraints: { audio: true, video: false },
            pcConfig: { iceServers: [] },
        })
    }

    function answer() {
        if (!incomingCall) {
            console.warn('[SIP] answer() called with no incomingCall')
            return
        }
        // Hand the session straight to JsSIP — it does its own getUserMedia
        // and emits "failed" on the session if the mic is denied. Probing
        // up-front turned out to silently abort the whole answer flow when
        // it failed (e.g. because of an active AudioContext for ringtone),
        // leaving the popup stuck and the call timing out at FS.
        console.info('[SIP] answer() — calling session.answer()', {
            sessionStatus: incomingCall.session?.status,
        })
        try {
            incomingCall.session.answer({
                mediaConstraints: { audio: true, video: false },
                pcConfig: { iceServers: [] },
            })
            console.info('[SIP] session.answer() returned (waiting for accepted/failed event)')
        } catch (err: any) {
            console.error('[SIP] session.answer() threw:', err)
            import('sonner').then(s => s.toast.error(`Не удалось принять: ${err?.message ?? err}`)).catch(() => {})
        }
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
