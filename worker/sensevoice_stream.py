# How to run: <venv python> worker/sensevoice_stream.py bin/sensevoice [threads]
"""Second recognizer for live correction: SenseVoiceSmall (sherpa-onnx, CPU) over a tab-separated line protocol.

Request: <id>\t<base64 s16le 16 kHz mono, at most 30 s>\n
Reply:   {"id": ..., "text": ..., "inference_ms": ...} or {"id": ..., "error": ...}
"""

from __future__ import annotations

import base64
import binascii
import json
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx

LIMIT = 1_400_000
MAX_PCM_BYTES = 960_000


def reply(value: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    directory = Path(sys.argv[1])
    threads = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(directory / "model.onnx"), tokens=str(directory / "tokens.txt"),
        language="ko", use_itn=True, num_threads=threads, provider="cpu")
    reply({"ready": True, "engine": "sherpa-onnx " + sherpa_onnx.__version__, "model": "SenseVoiceSmall-2024-07-17", "threads": threads})
    for line in sys.stdin:
        if len(line) > LIMIT:
            reply({"id": None, "error": "request limit exceeded"})
            continue
        fields = line.rstrip("\n").split("\t")
        if len(fields) != 2:
            reply({"id": None, "error": "invalid request envelope"})
            continue
        request_id, payload = fields
        try:
            pcm = base64.b64decode(payload, validate=True)
        except binascii.Error:
            reply({"id": request_id, "error": "invalid audio encoding"})
            continue
        if not pcm or len(pcm) > MAX_PCM_BYTES or len(pcm) % 2:
            reply({"id": request_id, "error": "audio must be up to 30 s of s16le"})
            continue
        started = time.perf_counter()
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0)
        recognizer.decode_stream(stream)
        reply({"id": request_id, "text": stream.result.text.strip(), "inference_ms": round((time.perf_counter() - started) * 1000)})


if __name__ == "__main__":
    main()

