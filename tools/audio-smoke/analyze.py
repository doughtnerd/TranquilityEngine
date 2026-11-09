#!/usr/bin/env python3
"""Reports RMS (dBFS) and the strongest frequency of a WAV (16-bit PCM)."""
import sys, wave
import numpy as np
w = wave.open(sys.argv[1])
rate, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
a = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768
a = a.reshape(-1, ch).mean(axis=1) if ch > 1 else a
rms = float(np.sqrt(np.mean(a ** 2))) if len(a) else 0.0
db = 20 * np.log10(rms) if rms > 0 else float("-inf")
peak_hz, ratio = 0.0, 0.0
if rms > 1e-6:
    s = np.abs(np.fft.rfft(a * np.hanning(len(a))))
    k = int(np.argmax(s[1:])) + 1
    peak_hz = k * rate / len(a)
    ratio = float(s[k] / (np.sqrt(np.sum(s ** 2)) + 1e-12))
print(f"{sys.argv[1]}: {len(a)/rate:.2f}s rate {rate} rms {rms:.5f} ({db:.1f} dBFS) peak {peak_hz:.1f} Hz (share of spectrum {ratio:.2f})")
