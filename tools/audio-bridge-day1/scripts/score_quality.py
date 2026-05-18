#!/usr/bin/env python3
"""
Issue #23 — objective speech quality scoring.

Compares a reference WAV against a degraded WAV (e.g. a recording made
during a call after FS playback / RTP egress / receiver decode). Outputs
a JSON report with multiple metrics so we stop relying on subjective
"чище / рваный" calls.

Metrics:
  * PESQ MOS-LQO  — ITU-T P.862, narrowband (8 kHz) or wideband (16 kHz).
                    Scale 1.0 (bad) → 4.5 (transparent).
  * Sample-level alignment offset (ms) — how far the degraded recording
    lags the reference. Critical to align before scoring; un-aligned
    samples score garbage.
  * SNR (signal-to-noise ratio, dB) — coarse but cheap discontinuity
    indicator. Computed on aligned samples.
  * Length match — degraded should be ≥ reference duration after align.

Usage:
  python3 score_quality.py <reference.wav> <degraded.wav> [--mode nb|wb]

The default mode auto-detects:
  - both 8 kHz mono  → 'nb' (narrowband PESQ)
  - both 16 kHz mono → 'wb' (wideband PESQ)
  - mixed rates      → resample degraded to ref's rate before scoring

Returns exit code 0 on success, prints JSON on stdout, prints warnings
to stderr.
"""

import argparse
import json
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly, correlate
from pesq import pesq


def read_mono(path):
    """Load WAV, downmix to mono float32 in [-1, 1]."""
    sr, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        data = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.uint8:
        data = (data.astype(np.float32) - 128) / 128.0
    else:
        data = data.astype(np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    return sr, data


def resample_to(sr_in, sig, sr_out):
    if sr_in == sr_out:
        return sig
    # Use polyphase resampling — high quality, fast for integer ratios.
    from math import gcd
    g = gcd(sr_in, sr_out)
    up = sr_out // g
    down = sr_in // g
    return resample_poly(sig, up, down)


def find_alignment_offset(ref, deg, sr, max_search_sec=2.0):
    """Cross-correlate to find the lag of degraded relative to reference.
    Returns the offset in samples (deg index - ref index)."""
    # Only correlate the first few seconds to keep CPU bounded.
    n = min(int(2 * sr), len(ref), len(deg))
    ref_segment = ref[:n] - np.mean(ref[:n])
    deg_segment = deg[: n + int(max_search_sec * sr)] - np.mean(deg[: n + int(max_search_sec * sr)])
    # Normalised cross-correlation
    corr = correlate(deg_segment, ref_segment, mode='valid')
    if corr.size == 0:
        return 0
    return int(np.argmax(corr))


def snr_db(ref, deg):
    """Compute SNR after aligning lengths."""
    n = min(len(ref), len(deg))
    ref = ref[:n]
    deg = deg[:n]
    # Normalise gain — match RMS energy so we measure SHAPE diff, not level diff
    ref_rms = np.sqrt(np.mean(ref ** 2) + 1e-12)
    deg_rms = np.sqrt(np.mean(deg ** 2) + 1e-12)
    if deg_rms > 1e-9:
        deg = deg * (ref_rms / deg_rms)
    noise = ref - deg
    sig_power = np.mean(ref ** 2)
    noise_power = np.mean(noise ** 2) + 1e-12
    return float(10.0 * np.log10(sig_power / noise_power))


def main():
    parser = argparse.ArgumentParser(description='PESQ MOS-LQO + SNR vs reference')
    parser.add_argument('reference', help='Reference WAV (clean)')
    parser.add_argument('degraded', help='Degraded WAV (recording)')
    parser.add_argument('--mode', choices=['nb', 'wb', 'auto'], default='auto',
                        help='PESQ band mode (default: auto by rate)')
    parser.add_argument('--align', action='store_true', default=True,
                        help='Auto-align degraded to reference via xcorr (default: on)')
    args = parser.parse_args()

    ref_sr, ref = read_mono(args.reference)
    deg_sr, deg = read_mono(args.degraded)

    # Resample degraded to reference rate so PESQ is happy.
    if deg_sr != ref_sr:
        print(f'[info] resampling degraded {deg_sr}→{ref_sr}', file=sys.stderr)
        deg = resample_to(deg_sr, deg, ref_sr)
        deg_sr = ref_sr

    sr = ref_sr
    mode = args.mode
    if mode == 'auto':
        if sr == 8000:
            mode = 'nb'
        elif sr == 16000:
            mode = 'wb'
        else:
            # PESQ only supports 8k/16k; resample for scoring.
            target = 16000 if sr >= 16000 else 8000
            print(f'[info] PESQ needs 8k or 16k — resampling {sr}→{target}', file=sys.stderr)
            ref = resample_to(sr, ref, target)
            deg = resample_to(sr, deg, target)
            sr = target
            mode = 'nb' if sr == 8000 else 'wb'

    # Alignment offset
    offset = 0
    if args.align:
        offset = find_alignment_offset(ref, deg, sr)
        if offset > 0:
            deg = deg[offset:]

    # PESQ scoring — needs aligned segments of equal length.
    n = min(len(ref), len(deg))
    ref_p = ref[:n].astype(np.float32)
    deg_p = deg[:n].astype(np.float32)

    try:
        mos = pesq(sr, ref_p, deg_p, mode)
    except Exception as e:
        print(f'[error] PESQ failed: {e}', file=sys.stderr)
        mos = None

    report = {
        'reference': args.reference,
        'degraded': args.degraded,
        'sample_rate': int(sr),
        'pesq_mode': mode,
        'pesq_mos_lqo': float(mos) if mos is not None else None,
        'pesq_interpretation': interpret_mos(mos),
        'alignment_offset_samples': int(offset),
        'alignment_offset_ms': float(offset / sr * 1000),
        'ref_duration_ms': float(len(ref) / sr * 1000),
        'deg_duration_ms': float(len(deg) / sr * 1000),
        'compared_duration_ms': float(n / sr * 1000),
        'snr_db': snr_db(ref_p, deg_p),
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))


def interpret_mos(mos):
    if mos is None:
        return 'unscored'
    # PESQ-MOS-LQO scale:
    #   4.0+ : transparent / very good
    #   3.5–4.0 : good (typical WebRTC clean)
    #   3.0–3.5 : fair (telephony)
    #   2.5–3.0 : poor (mild jitter / packet loss)
    #   2.0–2.5 : bad
    #   < 2.0   : unacceptable
    if mos >= 4.0: return 'transparent (very good)'
    if mos >= 3.5: return 'good (clean VoIP)'
    if mos >= 3.0: return 'fair (typical telephony)'
    if mos >= 2.5: return 'poor (jitter/loss audible)'
    if mos >= 2.0: return 'bad'
    return 'unacceptable'


if __name__ == '__main__':
    main()
