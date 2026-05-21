# `tools/audio-bridge-day1/scripts/` — audio diagnostics

On-demand tooling for objective voice-quality measurement and FreeSWITCH
playback A/B. Built during the issue #23 protocol that established the
AI-call pipeline is production-viable at the transport level. Keeps the
next "is this change actually better?" question one command away
instead of a subjective listening loop.

Nothing here auto-runs. Every entry point requires explicit `node` /
`bash` / `python3` invocation. No production paths import these.

## When to reach for what

| Question | Tool | Output |
|---|---|---|
| Is this WAV objectively closer to the reference than that one? | `score_quality.py` | PESQ MOS-LQO + SNR + alignment offset (JSON) |
| Does FS config X give a different MOS than config Y? | `run_quality_matrix.js` | Table across N originate-and-capture cycles |
| What does the user actually hear out of the softphone? | `webrtc_capture_auto.js` + `diag_upload_server.py` + `score_browser_capture.sh` | WAV of received audio + score vs reference |
| Is FS sending RTP packets on time, or bursting? | `capture_rtp_to_megafon.sh` + `analyze_rtp_pacing.js` | Inter-packet delta histogram, late/burst counters |
| Does this WAV have audible micro-gaps the analyzer can pick up? | `analyze_local_wav.js` | Silence-run distribution, top gap durations |
| Are two WAVs sample-identical (after alignment)? | `diff_wav_samples.js` | Bit-diff count, per-window divergence histogram |
| I need a known-broken WAV to validate a metric on. | `inject_dropouts.py` | WAV with deterministic silence gaps |
| I need an A/B/C listening set of the same Russian phrase. | `generate_23_listening_set.js` | 3 WAVs in `.claude/diag-23/<ts>/` |
| Does mod_audio_fork mono/mixed/stereo + pause/resume still work in this build? | `test_mod_audio_fork.js` | Fps + bytes/frame per mix-type, pause/resume effective yes/no |
| Are Yandex TTS keys + module + format ready to flip to prod? | `probe_yandex_tts.js` | 5-step JSON report, persisted WAV for manual listen |

## Quick recipes

### Score one WAV vs reference
```bash
wsl python3 score_quality.py <reference.wav> <degraded.wav>
```
Validates baseline: identity pair → MOS 4.55, identity by accident → catches bug.

### Compare FS configs end-to-end
1. Paste `webrtc_capture_auto.js` into the CRM softphone tab DevTools (or
   inject via Claude in Chrome MCP). Snippet auto-POSTs each capture
   to `http://127.0.0.1:3033/`.
2. Start the upload server: `wsl python3 diag_upload_server.py` (writes
   to `/dev/shm/test-23/uploads/`).
3. Edit `CONFIGS` in `run_quality_matrix.js` for the variations you want.
4. `node run_quality_matrix.js`

Each config: originates a `&playback()` to user/103, browser captures
the inbound audio, server-side ffmpeg + PESQ score, comparison table at
end.

### Capture and analyse FS RTP egress
```bash
wsl bash capture_rtp_to_megafon.sh start
# ...make a call through the trunk...
wsl bash capture_rtp_to_megafon.sh stop
wsl bash -c 'tcpdump -tttt -nn -q -r /dev/shm/test-23/rtp.pcap \
    "src host $(ip -4 addr show eth0 | awk "/inet /{print \$2}" | cut -d/ -f1)"' \
  | node analyze_rtp_pacing.js
```
Expected for healthy FS: median 20 ms, σ < 5 ms, >99 % within ±2 ms of 20 ms.

### Validate a quality metric
```bash
wsl python3 inject_dropouts.py clean.wav broken.wav --gap-ms 50 --period-ms 200
wsl python3 score_quality.py clean.wav broken.wav
# Expect MOS ~1.2 — sanity that the metric reacts to dropouts.
```

## Configuration knobs (env)

| Var | Default | Used by | Purpose |
|---|---|---|---|
| `FS_ESL_HOST` / `FS_ESL_PORT` / `ESL_PASSWORD` | `127.0.0.1` / `8021` / `ClueCon` | originate helpers | FreeSWITCH ESL |
| `RTP_TIMER` | (unset → profile default) | `test_softphone_playback.js` | Channel-var override (`soft`, `timerfd`) |
| `PLAYBACK_BUF_LEN` | (unset → FS default) | `test_softphone_playback.js` | `playback_buffer_len` channel var |
| `DIAG_OUT_DIR` | repo `.claude/diag-23` | `generate_23_listening_set.js` | Where listening-set WAVs land |
| `SBC_IP` | `193.201.229.35` (Megafon) | `capture_rtp_to_megafon.sh` | SIP signalling IP filter |
| `PCAP_DIR` | `/dev/shm/test-23` | `capture_rtp_to_megafon.sh` | pcap output dir |
| `UPLOAD_PORT` | `3033` | `diag_upload_server.py` | CORS receiver port |
| `FFMPEG_BIN` | `which ffmpeg` | `score_browser_capture.sh` | Override ffmpeg binary |
| `REFERENCE_WAV` / `REFERENCE_8K_WAV` | C-nova-24k / C-nova-8k | `run_quality_matrix.js` | Reference audio for scoring |

## Dependencies

Install once on the box (WSL Ubuntu):
```bash
sudo apt install -y tcpdump ffmpeg python3-pip python3-numpy python3-scipy
sudo pip3 install --break-system-packages pesq
```

Node side reuses the bridge's existing `dotenv` + `ws` etc. — no new
npm deps for the matrix runner itself.

## Hard constraints (intentional)

- **WSL Ubuntu only** for tcpdump + ffmpeg + pesq. Scripts assume
  `/dev/shm` and Linux paths.
- **No write access to the production audio path.** All scripts write
  to `/dev/shm/test-23/` or `.claude/diag-23/`, never to
  `BRIDGE_AUDIO_DIR` or `RECORDINGS_HOST_PATH`.
- **Originate helpers fire real calls.** `test_softphone_playback.js`
  and `test_fs_playback_only.js` dial through the gateway and cost
  trunk minutes. Not safe to run from CI.
- **Browser snippet patches `RTCPeerConnection` globally.** Each open
  CRM tab where the snippet is pasted will start capturing. Close those
  tabs (or call `window.RTCPeerConnection = WrappedPC.__originalCtor`)
  when you're done — they leak a constructor wrap otherwise.
