#!/bin/bash
# Issue #23 wrapper — score a browser-captured WebRTC inbound recording
# against a reference WAV.
#
#   $1 = reference WAV (the clean WAV we played via FS)
#   $2 = captured file (webm from DevTools snippet OR pre-converted wav)
#
# Output: JSON report from score_quality.py (PESQ MOS-LQO + SNR + alignment).
#
# The browser MediaRecorder emits audio/webm;codecs=opus — PESQ wants
# linear PCM at 8 or 16 kHz. ffmpeg handles the decode + resample in one
# pass. Output goes to a tmp WAV next to the input for inspection.
set -e

if [ $# -lt 2 ]; then
    echo "usage: $0 <reference.wav> <captured.{webm,wav}>" >&2
    exit 1
fi

REF="$1"
CAP="$2"
OUT_WAV="${CAP%.*}.converted-8k.wav"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Prefer the WSL-native ffmpeg (sudo apt install ffmpeg). Falls back to
# the Windows binary shipped with gravity-mvp's @ffmpeg-installer if not
# available — but that .exe runs in Windows context and needs translated
# paths, which is fragile.
FFMPEG="${FFMPEG_BIN:-$(which ffmpeg 2>/dev/null || echo /mnt/d/Github/CRM/gravity-mvp/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe)}"

# Detect: if input is already a wav at 8 kHz mono we can skip the ffmpeg step,
# but the resample/format-normalise pass is cheap and idempotent, so always
# run it for consistency.
echo "[wrapper] converting $CAP → $OUT_WAV (8 kHz mono linear16)" >&2
"$FFMPEG" -y -loglevel error -i "$CAP" -ar 8000 -ac 1 -acodec pcm_s16le \
    -map_metadata -1 -fflags +bitexact -flags:a +bitexact "$OUT_WAV"

echo "[wrapper] scoring $OUT_WAV vs $REF" >&2
python3 "$SCRIPT_DIR/score_quality.py" "$REF" "$OUT_WAV"
