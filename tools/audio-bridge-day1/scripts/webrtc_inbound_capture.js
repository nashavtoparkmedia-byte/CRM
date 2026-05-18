/**
 * Issue #23 — browser DevTools snippet to capture inbound WebRTC audio.
 *
 * Paste the ENTIRE contents of this file into Chrome DevTools Console
 * (F12 → Console) while the CRM tab is open and the softphone (user/103)
 * is registered. The snippet:
 *
 *   1. Patches RTCPeerConnection so every NEW peer connection (the CRM's
 *      SIP softphone makes a fresh one per call) is wrapped with a
 *      receiver-track recorder.
 *   2. When an inbound audio track lands on the wrapped PC, MediaRecorder
 *      starts (audio/webm;codecs=opus, 48 kHz).
 *   3. When the track ends (call hangs up), MediaRecorder stops and the
 *      capture downloads itself to your default Downloads folder as
 *      `webrtc-inbound-<timestamp>.webm`.
 *
 * Workflow:
 *   - Run snippet ONCE per CRM tab session.
 *   - Make/receive a test call from FS playback test scripts.
 *   - File downloads when call ends.
 *   - Hand the webm path back to the diagnostic — score_quality.py + ffmpeg
 *     convert to WAV and compare against the reference.
 *
 * Limitations:
 *   - Hooks only PCs created AFTER paste. A pre-existing call won't be
 *     captured; re-run the call after pasting.
 *   - Capture rate = audio context default (typically 48 kHz). The PESQ
 *     scorer resamples on its side, so the rate mismatch is fine.
 *   - webm/opus is lossy. Acceptable for objective comparison vs reference
 *     because the same encoder runs in every capture (so deltas are
 *     comparable across configurations). For maximum-fidelity capture,
 *     switch to MediaStreamTrackProcessor (Chrome-only) — see the
 *     `// CAPTURE METHOD` block below.
 */

(function installWebRTCCapture() {
    if (window.__rtcCaptureInstalled) {
        console.log('[capture] already installed — make a call to record')
        return
    }
    window.__rtcCaptureInstalled = true

    const OriginalPC = window.RTCPeerConnection

    function attachToPC(pc, pcIdx) {
        console.log(`[capture] PC#${pcIdx} created — waiting for inbound audio track`)

        pc.addEventListener('track', ev => {
            if (ev.track.kind !== 'audio') return
            const trackId = ev.track.id.slice(0, 8)
            console.log(`[capture] PC#${pcIdx} got inbound audio track ${trackId} → starting MediaRecorder`)

            // Wrap the remote track into a fresh MediaStream — required for
            // MediaRecorder to ingest it (passing the bare track or the
            // event.streams[0] sometimes triggers Chrome quirks).
            const ms = new MediaStream([ev.track])

            // CAPTURE METHOD: MediaRecorder with audio/webm;codecs=opus.
            // Browser-built, no PCM assembly needed, downloads as a single
            // blob. The post-processor (ffmpeg in WSL) decodes to PCM for
            // PESQ scoring.
            let recorder
            try {
                recorder = new MediaRecorder(ms, { mimeType: 'audio/webm;codecs=opus' })
            } catch (e) {
                console.error(`[capture] MediaRecorder rejected mime — falling back to default:`, e)
                try { recorder = new MediaRecorder(ms) } catch (e2) {
                    console.error('[capture] MediaRecorder unavailable:', e2)
                    return
                }
            }

            const chunks = []
            recorder.addEventListener('dataavailable', e => {
                if (e.data && e.data.size > 0) chunks.push(e.data)
            })
            recorder.addEventListener('stop', () => {
                if (chunks.length === 0) {
                    console.warn(`[capture] PC#${pcIdx} stopped with 0 chunks — track may have been silent`)
                    return
                }
                const blob = new Blob(chunks, { type: recorder.mimeType })
                const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
                const fname = `webrtc-inbound-${stamp}-pc${pcIdx}.webm`
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = fname
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                setTimeout(() => URL.revokeObjectURL(url), 60_000)
                console.log(`[capture] saved: ${fname} (${blob.size} bytes, ${chunks.length} chunks)`)
            })
            recorder.addEventListener('error', e => {
                console.error('[capture] recorder error:', e)
            })

            // Auto-stop on track end (call hangup tears down media).
            ev.track.addEventListener('ended', () => {
                console.log(`[capture] PC#${pcIdx} track ${trackId} ended → stopping recorder`)
                if (recorder.state === 'recording') recorder.stop()
            })

            // Some browsers fire 'mute' instead of 'ended' on hangup.
            ev.track.addEventListener('mute', () => {
                console.log(`[capture] PC#${pcIdx} track ${trackId} muted → stopping recorder`)
                if (recorder.state === 'recording') recorder.stop()
            })

            // Also handle PC close (defensive).
            pc.addEventListener('connectionstatechange', () => {
                if ((pc.connectionState === 'closed' || pc.connectionState === 'failed') && recorder.state === 'recording') {
                    console.log(`[capture] PC#${pcIdx} connectionState=${pc.connectionState} → stopping recorder`)
                    recorder.stop()
                }
            })

            recorder.start(/* timeslice= */ 1000)
            console.log(`[capture] PC#${pcIdx} recording started (timeslice 1s)`)
        })
    }

    let pcCounter = 0
    // class form preserves `instanceof RTCPeerConnection` checks in the
    // softphone library — assigning to .prototype directly breaks them.
    class WrappedPC extends OriginalPC {
        constructor(...args) {
            super(...args)
            pcCounter++
            attachToPC(this, pcCounter)
        }
    }
    window.RTCPeerConnection = WrappedPC

    console.log('[capture] installed. Make/receive a call — inbound audio will be recorded and auto-downloaded as webm when the call ends.')
})()
