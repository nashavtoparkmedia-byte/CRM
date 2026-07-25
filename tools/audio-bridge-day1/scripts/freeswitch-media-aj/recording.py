from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import sys
import wave


FRAME_SAMPLES = 160


def tone_amplitude(samples: list[int], sample_rate: int, frequency: float) -> float:
    if not samples:
        return 0.0
    sin_sum = 0.0
    cos_sum = 0.0
    for index, sample in enumerate(samples):
        angle = 2.0 * math.pi * frequency * index / sample_rate
        sin_sum += sample * math.sin(angle)
        cos_sum += sample * math.cos(angle)
    return 2.0 * math.hypot(sin_sum, cos_sum) / len(samples)


def analyze_recording(
    path: Path,
    *,
    source_hz: float,
    return_hz: float,
    peer_return_hz: float | None = None,
) -> dict[str, object]:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    if sample_width != 2:
        raise ValueError(f"expected 16-bit PCM WAV, got sample width {sample_width}")
    if channels != 2:
        raise ValueError(f"expected stereo recording, got {channels} channels")
    if sample_rate != 8000:
        raise ValueError(f"expected 8000 Hz recording, got {sample_rate}")

    signed = [
        int.from_bytes(raw[offset : offset + 2], byteorder="little", signed=True)
        for offset in range(0, len(raw), 2)
    ]
    per_channel = [signed[channel::channels] for channel in range(channels)]
    rms = math.sqrt(sum(sample * sample for sample in signed) / max(1, len(signed)))
    peak = max((abs(sample) for sample in signed), default=0)
    silence_ratio = sum(1 for sample in signed if abs(sample) < 100) / max(1, len(signed))

    frequencies = sorted(
        {
            200.0,
            float(source_hz),
            float(return_hz),
            float(return_hz) - 97.0,
            float(return_hz) + 103.0,
            *([] if peer_return_hz is None else [float(peer_return_hz)]),
        }
    )
    amplitudes: list[dict[str, float]] = []
    for channel_samples in per_channel:
        amplitudes.append(
            {
                f"hz_{frequency:g}": tone_amplitude(
                    channel_samples,
                    sample_rate,
                    frequency,
                )
                for frequency in frequencies
            }
        )

    def maximum(frequency: float) -> float:
        key = f"hz_{float(frequency):g}"
        return max(channel[key] for channel in amplitudes)

    def strongest_channel(frequency: float) -> int:
        key = f"hz_{float(frequency):g}"
        return max(range(channels), key=lambda index: amplitudes[index][key])

    source_amplitude = maximum(source_hz)
    return_amplitude = maximum(return_hz)
    adjacent_amplitude = max(
        maximum(return_hz - 97.0),
        maximum(return_hz + 103.0),
    )
    peer_amplitude = 0.0 if peer_return_hz is None else maximum(peer_return_hz)
    source_channel = strongest_channel(source_hz)
    return_channel = strongest_channel(return_hz)

    marker_match = return_amplitude > 500 and return_amplitude > adjacent_amplitude * 3
    source_present = source_amplitude > 500
    direction_distinct = (
        source_channel != return_channel
        and amplitudes[source_channel][f"hz_{float(source_hz):g}"]
        > amplitudes[return_channel][f"hz_{float(source_hz):g}"] * 2
        and amplitudes[return_channel][f"hz_{float(return_hz):g}"]
        > amplitudes[source_channel][f"hz_{float(return_hz):g}"] * 2
    )
    peer_contamination = (
        peer_return_hz is not None
        and peer_amplitude > max(100.0, return_amplitude / 10.0)
    )

    return {
        "path": str(path),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "bytes": path.stat().st_size,
        "duration_seconds": frame_count / sample_rate,
        "sample_rate": sample_rate,
        "channels": channels,
        "sample_width_bytes": sample_width,
        "sample_count": frame_count,
        "fs_recorded_frames": frame_count // FRAME_SAMPLES,
        "rms": rms,
        "peak": peak,
        "silence_ratio": silence_ratio,
        "tone_amplitudes": amplitudes,
        "source_hz": source_hz,
        "return_hz": return_hz,
        "peer_return_hz": peer_return_hz,
        "source_amplitude": source_amplitude,
        "return_amplitude": return_amplitude,
        "peer_return_amplitude": peer_amplitude,
        "source_channel": source_channel,
        "return_channel": return_channel,
        "marker_match": marker_match,
        "source_present": source_present,
        "direction_distinct": direction_distinct,
        "cross_session_contamination": peer_contamination,
        "silence_only": peak < 100,
    }


def main() -> int:
    if len(sys.argv) not in {4, 5}:
        raise SystemExit(
            "usage: recording.py <recording.wav> <source-hz> <return-hz> [peer-return-hz]"
        )
    result = analyze_recording(
        Path(sys.argv[1]),
        source_hz=float(sys.argv[2]),
        return_hz=float(sys.argv[3]),
        peer_return_hz=None if len(sys.argv) == 4 else float(sys.argv[4]),
    )
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
