"""Measure where recorded session audio appears in the official video audio.

Usage: python scripts/verify-video-alignment.py <video.pcm> <output.json> <session.pcm>... 
All inputs are 16 kHz mono s16le. Probes of 30 s every 300 s are located by log-energy envelope correlation over the
whole video, then refined with waveform correlation. Requires numpy. Read-only for all inputs.
"""
import json, sys
import numpy as np

SR, HOP, WIN, PROBE_S, STEP_S = 16000, 160, 400, 30, 300

def envelope(x):
    x = x.astype(np.float64) / 32768.0
    x = np.concatenate(([x[0]], x[1:] - 0.97 * x[:-1]))
    cs = np.concatenate(([0.0], np.cumsum(x * x)))
    n = (len(x) - WIN) // HOP + 1
    idx = np.arange(n) * HOP
    return np.log((cs[idx + WIN] - cs[idx]) / WIN + 1e-9)

def ncc(signal, probe):
    m = len(probe); p = probe - probe.mean(); pn = np.sqrt((p * p).sum())
    size = 1 << int(np.ceil(np.log2(len(signal) + m)))
    num = np.fft.irfft(np.fft.rfft(signal, size) * np.conj(np.fft.rfft(p, size)), size)[: len(signal) - m + 1]
    cs = np.concatenate(([0.0], np.cumsum(signal))); cs2 = np.concatenate(([0.0], np.cumsum(signal * signal)))
    s = cs[m:] - cs[:-m]; s2 = cs2[m:] - cs2[:-m]
    var = np.maximum(s2 - s * s / m, 1e-12)
    return num / (np.sqrt(var) * pn)

def main():
    video_path, out_path, sessions = sys.argv[1], sys.argv[2], sys.argv[3:]
    video = np.fromfile(video_path, dtype='<i2'); venv = envelope(video)
    results = []
    for path in sessions:
        audio = np.fromfile(path, dtype='<i2'); aenv = envelope(audio); total = len(audio) / SR
        for start in np.arange(15, total - PROBE_S, STEP_S):
            f0 = int(start * SR / HOP); m = int(PROBE_S * SR / HOP)
            probe = aenv[f0:f0 + m]
            if probe.std() < 0.5:
                results.append({'session': path, 'pcm_s': float(start), 'status': 'silent'}); continue
            corr = ncc(venv, probe); best = int(np.argmax(corr)); peak = float(corr[best])
            mask = np.abs(np.arange(len(corr)) - best) > int(2 * SR / HOP)
            second = float(corr[mask].max()) if mask.any() else 0.0
            coarse = best * HOP / SR
            a = audio[int(start * SR): int((start + PROBE_S) * SR)].astype(np.float64)
            lo = max(0, int((coarse - 0.2) * SR)); hi = min(len(video), int((coarse + PROBE_S + 0.2) * SR))
            v = video[lo:hi].astype(np.float64)
            fine = coarse; wave_peak = None
            if len(v) > len(a):
                c = ncc(v, a); k = int(np.argmax(c)); fine = (lo + k) / SR; wave_peak = float(c[k])
            results.append({'session': path, 'pcm_s': float(start), 'video_s': round(fine, 4), 'offset_s': round(fine - start, 4),
                            'envelope_peak': round(peak, 3), 'second_peak': round(second, 3), 'wave_peak': None if wave_peak is None else round(wave_peak, 3),
                            'status': 'matched' if peak >= 0.6 and peak - second >= 0.15 else 'ambiguous'})
            print(json.dumps(results[-1], ensure_ascii=False), flush=True)
    summary = {}
    for path in sessions:
        rows = [r for r in results if r['session'] == path and r['status'] == 'matched']
        offsets = np.array([r['offset_s'] for r in rows])
        if len(offsets):
            summary[path] = {'probes': len([r for r in results if r['session'] == path]), 'matched': len(rows),
                             'offset_median_s': round(float(np.median(offsets)), 4), 'offset_min_s': round(float(offsets.min()), 4),
                             'offset_max_s': round(float(offsets.max()), 4)}
    json.dump({'video': video_path, 'video_seconds': len(video) / SR, 'probe_seconds': PROBE_S, 'step_seconds': STEP_S,
               'summary': summary, 'probes': results}, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False, indent=1))

if __name__ == '__main__':
    main()

