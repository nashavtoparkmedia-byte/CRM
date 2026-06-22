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

// Default WebRTC ICE config — overridden at runtime from /api/calls/sip-credentials.
// Fallback keeps WSL2 local dev working without env vars.
const DEFAULT_TURN_PC_CONFIG = {
    iceServers: [
        { urls: 'stun:127.0.0.1:3478' },
        { urls: 'turn:127.0.0.1:3478?transport=tcp', username: 'crm', credential: 'turnpass' },
    ],
    iceTransportPolicy: 'all' as const,
}

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

export type SipStatus = 'idle' | 'connecting' | 'registered' | 'unregistered' | 'failed' | 'disabled'
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
    // FreeSWITCH channel UUID of the a-leg trunk call. Set as soon as
    // /api/calls/originate returns (placeholder phase, before the b-leg
    // INVITE upgrades session). Needed so hangup() can POST /api/calls/cancel
    // → uuid_kill to stop Megafon ringing the callee when the manager hangs
    // up before the b-leg ever arrives.
    fsUuid: string | null
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
    // Opens a placeholder outbound call (state='connecting', session=null) so the
    // ActiveCallPopup shows "Дозваниваюсь…" the instant the user clicks Позвонить,
    // before FS rings back the b-leg INVITE. The real session upgrades the
    // placeholder in handleIncomingSession when the bridge callback arrives.
    startPlaceholderOutbound(phoneNumber: string, displayName?: string | null): void
    // Tears down a placeholder if /api/calls/originate failed or the user hung up
    // before the b-leg INVITE arrived. No-op once the real session has attached.
    cancelPlaceholderOutbound(): void
    // Attach the FS channel UUID returned from /api/calls/originate to the
    // current placeholder so a subsequent hangup() can target it via uuid_kill.
    setActiveCallFsUuid(fsUuid: string): void
}

const SipContext = createContext<SipApi | null>(null)

export function useSip(): SipApi {
    const ctx = useContext(SipContext)
    if (!ctx) throw new Error('useSip must be used inside SipProvider')
    return ctx
}

// ---------------------------------------------------------------------------
// Module-level UA singleton
//
// WHY: SipProvider remounts every time incomingCall state changes (React
// concurrent-mode re-render or Next.js hydration artefact). Without a
// singleton, each remount kills the JsSIP UA and creates a new one.
// FreeSWITCH retransmits the unanswered INVITE to the new UA, which
// immediately triggers another setIncomingCall → remount → new UA → …
// The call is never answerable.
//
// FIX: keep the UA alive across React remounts via a module-level variable.
// Forwarding callbacks (_sipCallbacks) always point at the CURRENT component
// instance's handlers so state updates reach the mounted component.
// ---------------------------------------------------------------------------
let _singletonUa: any = null
let _singletonPcConfig: RTCConfiguration = DEFAULT_TURN_PC_CONFIG
// Synchronous guard: set to true BEFORE the first await so concurrent
// React mount calls all see it and skip duplicate UA creation.
let _uaStarting = false

// Forwarding callbacks — updated on every render, called by the singleton UA.
const _sipCallbacks = {
    onRegistered: null as (() => void) | null,
    onUnregistered: null as (() => void) | null,
    onRegistrationFailed: null as ((e: any) => void) | null,
    onIncomingSession: null as ((session: any, request: any) => void) | null,
    onOutgoingSession: null as ((session: any) => void) | null,
}

export function SipProvider({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<SipStatus>('idle')
    const [extension, setExtension] = useState<string | null>(null)
    const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null)
    const [activeCall, setActiveCall] = useState<ActiveCallInfo | null>(null)

    const uaRef = useRef<any>(null)
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const pcConfigRef = useRef<RTCConfiguration>(DEFAULT_TURN_PC_CONFIG)

    // Update forwarding callbacks on every render so the singleton UA always
    // dispatches events to the currently mounted component's handlers.
    _sipCallbacks.onRegistered = () => setStatus('registered')
    _sipCallbacks.onUnregistered = () => setStatus('unregistered')
    _sipCallbacks.onRegistrationFailed = () => setStatus('failed')
    _sipCallbacks.onIncomingSession = (session, request) => handleIncomingSession(session, request)
    _sipCallbacks.onOutgoingSession = (session) => handleOutgoingSession(session)

    // --- Ringback tone (RU ГОСТ: 425 Hz, 1s on / 4s off) ---
    // JsSIP doesn't play SIP 180 Ringing progress media for us — and in the
    // click-to-call flow there isn't even a 180 to play, the b-leg INVITE
    // arrives already in-progress. So we synthesise the local ringback in
    // the browser via WebAudio so the user hears something between clicking
    // "Позвонить" and the remote party picking up.
    const ringbackRef = useRef<{
        ctx: AudioContext
        gain: GainNode
        osc: OscillatorNode
        interval: ReturnType<typeof setInterval>
    } | null>(null)

    function startRingback() {
        if (ringbackRef.current) return
        try {
            const AC: typeof AudioContext = (window as any).AudioContext ?? (window as any).webkitAudioContext
            if (!AC) return
            const ctx = new AC()
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.frequency.value = 425
            osc.type = 'sine'
            gain.gain.value = 0
            osc.connect(gain).connect(ctx.destination)
            osc.start()
            const tick = () => {
                const now = ctx.currentTime
                gain.gain.cancelScheduledValues(now)
                // Quick fade in/out (10 ms) prevents the click artifact that a
                // hard 0→0.1 jump on a sine wave produces.
                gain.gain.setValueAtTime(0, now)
                gain.gain.linearRampToValueAtTime(0.1, now + 0.01)
                gain.gain.setValueAtTime(0.1, now + 1)
                gain.gain.linearRampToValueAtTime(0, now + 1.01)
            }
            tick()
            const interval = setInterval(tick, 5000)
            ringbackRef.current = { ctx, osc, gain, interval }
        } catch (err) {
            console.warn('[SIP] ringback start failed:', err)
        }
    }

    function stopRingback() {
        const r = ringbackRef.current
        if (!r) return
        ringbackRef.current = null
        clearInterval(r.interval)
        try {
            const now = r.ctx.currentTime
            r.gain.gain.cancelScheduledValues(now)
            r.gain.gain.setValueAtTime(0, now)
            r.osc.stop()
            r.ctx.close()
        } catch {}
    }

    // --- Audio sink ---
    useEffect(() => {
        const el = document.createElement('audio')
        el.autoplay = true
        el.style.display = 'none'
        document.body.appendChild(el)
        audioRef.current = el
        return () => { el.remove() }
    }, [])

    // --- Debug DOM stats overlay (opt-in via NEXT_PUBLIC_SIP_DEBUG=1) ---
    // Renders getStats() output into a fixed <pre> at the bottom-right for
    // diagnostics when the JS console isn't reachable. Off by default; the
    // overlay is intrusive in regular UI use. Re-enable by setting the env
    // flag in `.env` and restarting the dev server.
    useEffect(() => {
        if (process.env.NEXT_PUBLIC_SIP_DEBUG !== '1') return
        const dbg = document.createElement('pre')
        dbg.id = 'sip-debug-stats'
        dbg.style.cssText = 'position:fixed;bottom:0;right:0;max-width:520px;max-height:240px;overflow:auto;font:11px monospace;background:#000c;color:#0f0;padding:4px;z-index:99999;white-space:pre-wrap;'
        document.body.appendChild(dbg)
        const timer = setInterval(async () => {
            const pc: any = (window as any).__lastPc
            if (!pc) { dbg.textContent = 'sip-debug-stats: no active pc'; return }
            try {
                const stats = await pc.getStats()
                const rows: any[] = []
                stats.forEach((r: any) => {
                    if (['inbound-rtp', 'outbound-rtp', 'candidate-pair', 'local-candidate', 'remote-candidate'].includes(r.type)) {
                        rows.push({ t: r.type, bR: r.bytesReceived, bS: r.bytesSent, st: r.state, ct: r.candidateType, ip: r.ip ?? r.address, p: r.port, pr: r.protocol, nominated: r.nominated })
                    }
                })
                dbg.textContent = JSON.stringify({ ts: new Date().toISOString().slice(11, 19), iceState: pc.iceConnectionState, sigState: pc.signalingState, rows }, null, 1)
            } catch (e: any) { dbg.textContent = 'getStats threw: ' + e?.message }
        }, 1000)
        return () => { clearInterval(timer); dbg.remove() }
    }, [])

    // --- Register UA on mount ---
    useEffect(() => {
        let cancelled = false
        ;(async () => {
            // If the singleton UA already exists OR is being created, this is a
            // React remount or a race-condition concurrent call. Reuse / skip.
            if (_singletonUa) {
                console.info('[SIP] component remounted — reusing singleton UA')
                uaRef.current = _singletonUa
                pcConfigRef.current = _singletonPcConfig
                setStatus(_singletonUa.isRegistered() ? 'registered' : 'connecting')
                return
            }
            if (_uaStarting) {
                console.info('[SIP] UA creation already in progress — skipping duplicate')
                return
            }
            // Claim the creation slot synchronously (before any await).
            _uaStarting = true

            setStatus('connecting')
            let creds: any
            try {
                const res = await fetch('/api/calls/sip-credentials', { cache: 'no-store' })
                if (!res.ok) { _uaStarting = false; setStatus('failed'); return }
                creds = await res.json()
            } catch { _uaStarting = false; setStatus('failed'); return }
            if (cancelled) { _uaStarting = false; return }

            if (creds.enabled === false) {
                // Телефония не настроена (нет SIP_WS_URL) — не поднимать UA вовсе
                _uaStarting = false
                setStatus('disabled')
                return
            }

            // Override TURN config with server-provided values (from env vars on the server).
            // Use iceTransportPolicy='all' so the browser tries host → STUN → TURN in order.
            // FreeSWITCH has a public IP so direct ICE usually succeeds without relay.
            if (creds.turn?.url) {
                const turnHost = creds.turn.url.replace(/^turn:/, '').replace(/\?.*$/, '')
                pcConfigRef.current = {
                    iceServers: [
                        { urls: `stun:${turnHost}` },
                        { urls: creds.turn.url, username: creds.turn.username, credential: creds.turn.credential },
                    ],
                    iceTransportPolicy: 'all',
                }
            }

            setExtension(creds.extension)

            // Turbopack sometimes wraps CJS in an ESM namespace with the real
            // module under .default, sometimes not — handle both shapes.
            const jssipModule = await import('jssip')
            const JsSIP: any = (jssipModule as any).default ?? jssipModule
            if (!JsSIP?.WebSocketInterface || !JsSIP?.UA) {
                console.error('[SIP] JsSIP module shape unexpected:', Object.keys(jssipModule), Object.keys(JsSIP ?? {}))
                _uaStarting = false
                setStatus('failed')
                return
            }
            // Dev-mode logging — comment out for production noise reduction.
            try { JsSIP.debug?.enable('JsSIP:*') } catch {}

            const socket = new JsSIP.WebSocketInterface(creds.wsUrl)
            // nginx terminates TLS, so FreeSWITCH's ws-binding sees a PLAIN ws
            // connection. JsSIP defaults the SIP Via transport to "WSS" for a
            // wss:// URL, and FreeSWITCH silently DROPS any REGISTER whose Via
            // says WSS on its ws listener → REGISTER times out → red SIP dot.
            // Force the Via transport to WS so it matches what FS actually sees.
            // (Verified: REGISTER with Via WS → 401 challenge; with Via WSS → dropped.)
            socket.via_transport = 'WS'

            // Persist the Contact URI user-part across page reloads so FreeSWITCH
            // sees the same Contact every time and REPLACES the existing binding
            // (same AOR + same Contact → UPDATE). Without this, each reload generates
            // a new random user-part, FS creates a new binding alongside the old one,
            // and sofia_contact keeps returning the stale dead WS port.
            const contactUser = (() => {
                const key = `__sip_contact_user_${creds.extension}__`
                try {
                    let v = localStorage.getItem(key)
                    if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem(key, v) }
                    return v
                } catch { return Math.random().toString(36).slice(2, 10) }
            })()

            const ua = new JsSIP.UA({
                uri: creds.sipUri,
                password: creds.password,
                authorization_user: creds.authUser,
                display_name: creds.displayName,
                contact_uri: `sip:${contactUser}@crm-softphone.invalid;transport=ws`,
                sockets: [socket],
                register: true,
                session_timers: false,
            })

            // Use forwarding callbacks (_sipCallbacks) so that event handlers
            // always reach the CURRENTLY mounted component even after a remount.
            ua.on('registered', () => { console.info('[SIP] registered'); _sipCallbacks.onRegistered?.() })
            ua.on('unregistered', () => { console.info('[SIP] unregistered'); _sipCallbacks.onUnregistered?.() })
            ua.on('registrationFailed', (e: any) => { console.error('[SIP] registrationFailed', e?.cause, e); _sipCallbacks.onRegistrationFailed?.(e) })
            ua.on('connecting', () => console.info('[SIP] ua connecting'))
            ua.on('connected', () => console.info('[SIP] ua connected'))
            ua.on('disconnected', (e: any) => console.warn('[SIP] ua disconnected', e?.code, e?.reason))

            ua.on('newRTCSession', (data: any) => {
                const session = data.session
                if (data.originator === 'remote') {
                    // Pass `data.request` explicitly — JsSIP 3.13 doesn't populate
                    // `session.request` synchronously at this point; the event
                    // payload is the only reliable place to read incoming headers.
                    _sipCallbacks.onIncomingSession?.(session, data.request)
                } else {
                    _sipCallbacks.onOutgoingSession?.(session)
                }
            })

            _singletonUa = ua
            _singletonPcConfig = pcConfigRef.current
            uaRef.current = ua
            ua.start()
        })()

        // Cleanup: keep the singleton UA alive across React remounts.
        // Only the module-level reference persists; the component's uaRef
        // is cleared so stale refs don't accumulate.
        return () => { cancelled = true; uaRef.current = null }
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
        // Read the P-CRM-Outbound-Bridge marker. JsSIP 3.13 doesn't populate
        // session.request synchronously inside the newRTCSession event — fall
        // back to event.data.request (passed in as eventRequest).
        const isOutboundBridge = (() => {
            try {
                const req = eventRequest ?? session.request
                const value = req?.getHeader?.('P-CRM-Outbound-Bridge')
                    ?? req?.headers?.['P-CRM-Outbound-Bridge']
                const str = typeof value === 'string' ? value : value?.raw ?? String(value ?? '')
                return /true/i.test(str.trim())
            } catch {
                return false
            }
        })()

        attachRemoteAudio(session)
        const remoteId = session.remote_identity
        const fromNumber = remoteId?.uri?.user ?? 'unknown'
        const displayName = remoteId?.display_name ?? null

        if (isOutboundBridge) {
            console.info('[SIP] outbound-bridge callback detected — auto-answering', { fromNumber })
            setActiveCall(prev => {
                // Upgrade in place if CallButton already opened a placeholder for
                // this outbound — preserves startedAt, peerNumber AND the fsUuid
                // we got from /api/calls/originate so hangup mid-call can still
                // uuid_kill the a-leg. No popup flicker.
                if (prev && !prev.session && prev.direction === 'outbound') {
                    return { ...prev, session, displayName: prev.displayName ?? displayName }
                }
                return {
                    direction: 'outbound',
                    peerNumber: fromNumber,
                    displayName,
                    state: 'connecting',
                    startedAt: Date.now(),
                    answeredAt: null,
                    session,
                    isMuted: false,
                    fsUuid: null,
                }
            })
            session.on('accepted', () => {
                stopRingback()
                setActiveCall(prev => {
                if (!prev || prev.session !== session) return prev
                return { ...prev, state: 'active', answeredAt: Date.now() }
            })
            })
            session.on('ended', () => {
                stopRingback()
                setActiveCall(prev => (prev?.session === session ? null : prev))
            })
            session.on('failed', () => {
                stopRingback()
                setActiveCall(prev => (prev?.session === session ? null : prev))
            })
            try {
                session.answer({
                    mediaConstraints: { audio: true, video: false },
                    pcConfig: pcConfigRef.current,
                })
            } catch (err: any) {
                stopRingback()
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
                fsUuid: null,
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
            fsUuid: null,
        })

        session.on('progress', () => {
            setActiveCall(prev => {
                if (!prev || prev.session !== session) return prev
                return { ...prev, state: 'ringing' }
            })
        })
        session.on('accepted', () => {
            setActiveCall(prev => {
                if (!prev || prev.session !== session) return prev
                return { ...prev, state: 'active', answeredAt: Date.now() }
            })
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
            pcConfig: pcConfigRef.current,
        })
    }

    function answer() {
        if (!incomingCall) {
            console.warn('[SIP] answer() called with no incomingCall')
            return
        }
        const session = incomingCall.session
        // JsSIP STATUS_WAITING_FOR_ANSWER = 4. Any other status means the session
        // has already been answered, cancelled, or terminated — calling answer()
        // again would throw "Invalid status: N" and show a confusing toast.
        if (session?.status !== undefined && session.status !== 4) {
            console.warn('[SIP] answer() skipped — session already in status', session.status)
            return
        }
        console.info('[SIP] answer() — pcConfig:', JSON.stringify(pcConfigRef.current))
        console.info('[SIP] answer() — calling session.answer()', { sessionStatus: session?.status })
        try {
            session.answer({
                mediaConstraints: { audio: true, video: false },
                pcConfig: pcConfigRef.current,
            })
            console.info('[SIP] session.answer() returned (waiting for accepted/failed event)')
            // Attach ICE debug listeners immediately after answer() so we can diagnose hangs
            setTimeout(() => {
                const pc = session.connection
                if (!pc) { console.warn('[SIP] no session.connection after answer()'); return }
                console.info('[SIP] RTCPeerConnection created, signalingState:', pc.signalingState,
                    'iceConnectionState:', pc.iceConnectionState, 'iceGatheringState:', pc.iceGatheringState)
                pc.addEventListener('iceconnectionstatechange', () =>
                    console.info('[SIP] iceConnectionState →', pc.iceConnectionState))
                pc.addEventListener('icegatheringstatechange', () =>
                    console.info('[SIP] iceGatheringState →', pc.iceGatheringState))
                pc.addEventListener('signalingstatechange', () =>
                    console.info('[SIP] signalingState →', pc.signalingState))
                pc.addEventListener('connectionstatechange', () =>
                    console.info('[SIP] connectionState →', pc.connectionState))
                pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) =>
                    console.info('[SIP] local ICE candidate:', e.candidate?.candidate ?? '(null=done)'))
                pc.onicecandidateerror = (e: any) =>
                    console.warn('[SIP] ICE candidate error:', e.errorCode, e.errorText, e.url)
                // Log remote SDP to see what FreeSWITCH sent
                if (pc.remoteDescription) {
                    console.info('[SIP] remote SDP:\n' + pc.remoteDescription.sdp)
                }
            }, 0)
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
        if (activeCall) {
            if (activeCall.session) {
                activeCall.session.terminate()
            } else {
                // Placeholder — no SIP session in the browser yet, but FS has
                // an in-flight originate dialling Megafon → callee. We MUST
                // tell the server to kill it, otherwise the callee's phone
                // keeps ringing until Megafon's ~30 s timeout even though the
                // manager already hit "Отбой". Fire-and-forget — UI clears
                // immediately, server-side uuid_kill propagates back through
                // CHANNEL_HANGUP_COMPLETE → SSE as a safety net.
                if (activeCall.fsUuid) {
                    fetch('/api/calls/cancel', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fsUuid: activeCall.fsUuid }),
                    }).catch(err => console.warn('[SIP] cancel originate request failed:', err))
                }
                stopRingback()
                setActiveCall(null)
            }
        }
        if (incomingCall) incomingCall.session.terminate()
    }

    function toggleMute() {
        if (!activeCall || !activeCall.session) return
        const session = activeCall.session
        if (activeCall.isMuted) {
            session.unmute({ audio: true })
        } else {
            session.mute({ audio: true })
        }
        setActiveCall({ ...activeCall, isMuted: !activeCall.isMuted })
    }

    function startPlaceholderOutbound(phoneNumber: string, displayName?: string | null) {
        // Don't clobber an already-running call.
        if (activeCall) return
        setActiveCall({
            direction: 'outbound',
            peerNumber: phoneNumber,
            displayName: displayName ?? null,
            state: 'connecting',
            startedAt: Date.now(),
            answeredAt: null,
            session: null,
            isMuted: false,
            fsUuid: null,
        })
        startRingback()
    }

    function cancelPlaceholderOutbound() {
        // Only tear down if it's still a placeholder. If FS already attached
        // the real session, leave it alone — user can hang up via ActiveCallPopup.
        setActiveCall(prev => (prev && !prev.session ? null : prev))
        stopRingback()
    }

    function setActiveCallFsUuid(fsUuid: string) {
        setActiveCall(prev => (prev ? { ...prev, fsUuid } : prev))
    }

    return (
        <SipContext.Provider value={{ status, extension, incomingCall, activeCall, call, answer, decline, hangup, toggleMute, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid }}>
            {children}
        </SipContext.Provider>
    )
}
