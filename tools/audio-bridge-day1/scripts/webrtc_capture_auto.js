/**
 * Issue #23 — automated WebRTC inbound capture for Claude-in-Chrome MCP.
 *
 * Same idea as webrtc_inbound_capture.js (DevTools-paste version), but
 * stores recorded blobs as base64 strings inside `window.__capturedBlobs`
 * instead of triggering a download. The MCP javascript_exec tool can
 * then read the array back, decode, and save server-side — no manual
 * file handling required.
 *
 * Public state on `window`:
 *   __rtcCaptureAutoInstalled  — installation flag
 *   __capturedBlobs            — Array<{ ts, pc, mime, base64 }>
 *   __captureStatus            — { pcCount, recorders, lastEvent }
 *
 * The snippet is idempotent — calling it again is a no-op (uses the
 * installation flag), so it's safe to re-inject between tests.
 */

(function installAutoCapture() {
    if (window.__rtcCaptureAutoInstalled) {
        return JSON.stringify({ ok: true, alreadyInstalled: true })
    }
    window.__rtcCaptureAutoInstalled = true
    window.__capturedBlobs = []
    window.__captureStatus = { pcCount: 0, recorders: 0, finished: 0, lastEvent: 'installed' }

    const OriginalPC = window.RTCPeerConnection

    function blobToBase64(blob) {
        return new Promise(resolve => {
            const r = new FileReader()
            r.onloadend = () => {
                // r.result is "data:<mime>;base64,<...>" — strip prefix
                const s = r.result
                const comma = s.indexOf(',')
                resolve(s.substring(comma + 1))
            }
            r.readAsDataURL(blob)
        })
    }

    function attachToPC(pc, pcIdx) {
        window.__captureStatus.lastEvent = `pc-${pcIdx}-created`

        pc.addEventListener('track', ev => {
            if (ev.track.kind !== 'audio') return
            window.__captureStatus.lastEvent = `pc-${pcIdx}-track-${ev.track.id.slice(0, 8)}`

            const ms = new MediaStream([ev.track])
            let recorder
            try {
                recorder = new MediaRecorder(ms, { mimeType: 'audio/webm;codecs=opus' })
            } catch (e) {
                try { recorder = new MediaRecorder(ms) } catch (e2) {
                    window.__captureStatus.lastEvent = `pc-${pcIdx}-no-recorder: ${e2.message}`
                    return
                }
            }
            window.__captureStatus.recorders++

            const chunks = []
            recorder.addEventListener('dataavailable', e => {
                if (e.data && e.data.size > 0) chunks.push(e.data)
            })
            recorder.addEventListener('stop', async () => {
                if (chunks.length === 0) {
                    window.__captureStatus.lastEvent = `pc-${pcIdx}-empty`
                    return
                }
                const blob = new Blob(chunks, { type: recorder.mimeType })
                const base64 = await blobToBase64(blob)
                window.__capturedBlobs.push({
                    ts: new Date().toISOString(),
                    pc: pcIdx,
                    mime: recorder.mimeType,
                    size: blob.size,
                    base64,
                })
                window.__captureStatus.finished++
                window.__captureStatus.lastEvent = `pc-${pcIdx}-saved-${blob.size}-bytes`
            })

            // Defensive: multiple stop-triggers.
            const stopSafe = () => {
                if (recorder.state === 'recording') recorder.stop()
            }
            ev.track.addEventListener('ended', stopSafe)
            ev.track.addEventListener('mute', stopSafe)
            pc.addEventListener('connectionstatechange', () => {
                if (pc.connectionState === 'closed' || pc.connectionState === 'failed') stopSafe()
            })

            recorder.start(1000)
            window.__captureStatus.lastEvent = `pc-${pcIdx}-recording`
        })
    }

    class WrappedPC extends OriginalPC {
        constructor(...args) {
            super(...args)
            window.__captureStatus.pcCount++
            const idx = window.__captureStatus.pcCount
            attachToPC(this, idx)
        }
    }
    window.RTCPeerConnection = WrappedPC

    return JSON.stringify({ ok: true, installed: true })
})()
