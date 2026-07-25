import json
import math
import os
import sys
import wave


def tone_amplitude(samples, sample_rate, frequency):
    if not samples:
        return 0.0
    sin_sum = 0.0
    cos_sum = 0.0
    for index, sample in enumerate(samples):
        angle = 2.0 * math.pi * frequency * index / sample_rate
        sin_sum += sample * math.sin(angle)
        cos_sum += sample * math.cos(angle)
    return 2.0 * math.hypot(sin_sum, cos_sum) / len(samples)


def main(path):
    with wave.open(path, "rb") as wav:
        channels = wav.getnchannels()
        sample_rate = wav.getframerate()
        sample_width = wav.getsampwidth()
        frame_count = wav.getnframes()
        raw = wav.readframes(frame_count)

    if sample_width != 2:
        raise SystemExit(f"expected 16-bit PCM WAV, got sample width {sample_width}")

    signed = [
        int.from_bytes(raw[offset : offset + 2], byteorder="little", signed=True)
        for offset in range(0, len(raw), 2)
    ]
    per_channel = [signed[channel::channels] for channel in range(channels)]
    rms = math.sqrt(sum(sample * sample for sample in signed) / max(1, len(signed)))
    peak = max((abs(sample) for sample in signed), default=0)

    amplitudes = []
    for channel_samples in per_channel:
        amplitudes.append(
            {
                "hz_440": tone_amplitude(channel_samples, sample_rate, 440),
                "hz_900": tone_amplitude(channel_samples, sample_rate, 900),
                "hz_997": tone_amplitude(channel_samples, sample_rate, 997),
                "hz_1100": tone_amplitude(channel_samples, sample_rate, 1100),
            }
        )

    source_amplitude = max(item["hz_440"] for item in amplitudes)
    return_amplitude = max(item["hz_997"] for item in amplitudes)
    adjacent_amplitude = max(max(item["hz_900"], item["hz_1100"]) for item in amplitudes)
    marker_match = return_amplitude > 500 and return_amplitude > adjacent_amplitude * 3
    source_present = source_amplitude > 500

    result = {
        "path": path,
        "bytes": os.path.getsize(path),
        "duration_seconds": frame_count / sample_rate,
        "sample_rate": sample_rate,
        "channels": channels,
        "sample_count": frame_count,
        "fs_recorded_frames": frame_count // 160,
        "rms": rms,
        "peak": peak,
        "tone_amplitudes": amplitudes,
        "marker_match": marker_match,
        "silence_only": peak < 100,
        "source_present": source_present,
        "source_return_distinct": marker_match and source_present,
    }
    print(json.dumps(result, sort_keys=True))

    if result["silence_only"] or not result["marker_match"] or not result["source_return_distinct"]:
        raise SystemExit(2)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: analyze_wav.py <recording.wav>")
    main(sys.argv[1])
