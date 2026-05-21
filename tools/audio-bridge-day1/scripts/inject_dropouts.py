#!/usr/bin/env python3
"""Inject deterministic silence gaps into a WAV to validate quality metrics.

Usage:
  python3 inject_dropouts.py <in.wav> <out.wav> [--gap-ms N] [--period-ms M]

Default: zero-fill a 50 ms window every 200 ms. This pattern mimics
short packet loss / late RTP frames — the exact thing we expect to see
when speech sounds "choppy" through FS over a jittery transport.
"""
import argparse
import numpy as np
from scipy.io import wavfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp')
    ap.add_argument('out')
    ap.add_argument('--gap-ms', type=int, default=50)
    ap.add_argument('--period-ms', type=int, default=200)
    args = ap.parse_args()

    sr, data = wavfile.read(args.inp)
    if data.ndim == 2:
        data = data[:, 0]
    gap = sr * args.gap_ms // 1000
    period = sr * args.period_ms // 1000

    out = data.copy()
    n_gaps = 0
    for start in range(period, len(out) - gap, period):
        out[start:start + gap] = 0
        n_gaps += 1
    wavfile.write(args.out, sr, out.astype(data.dtype))
    print(f'wrote {args.out}: {n_gaps} gaps of {args.gap_ms} ms every {args.period_ms} ms')


if __name__ == '__main__':
    main()
