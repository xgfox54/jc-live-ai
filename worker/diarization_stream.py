# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# How to run: python worker/diarization_stream.py bin/diarization [chunk_frames]
"""Bounded line protocol; one shared model, eight independent speaker caches."""

from __future__ import annotations

import array
import base64
import binascii
import json
import re
import sys
import time
from dataclasses import asdict, dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final, NewType, assert_never

from diarization_native import Geometry, NativeError, NativeModel

RequestId = NewType("RequestId", str)
StreamKey = NewType("StreamKey", str)
LIMIT: Final = 500000
ENVELOPE_FIELDS: Final = 4
MAX_PCM_BYTES: Final = 352000
CHUNK_ARG_INDEX: Final = 2


class Operation(StrEnum):
    OPEN = "open"
    PUSH = "push"
    FINISH = "finish"
    CLOSE = "close"


@dataclass(frozen=True, slots=True)
class Request:
    id: RequestId
    operation: Operation
    key: StreamKey
    audio: bytes

    @classmethod
    def parse(cls, line: str) -> Request:
        fields = line.rstrip("\n").split("\t")
        if len(fields) != ENVELOPE_FIELDS or len(line) > LIMIT:
            raise NativeError("Invalid request envelope")
        ident, action, key, encoded = fields
        if not re.fullmatch(r"[a-f0-9-]{36}", ident) or not re.fullmatch(r"[A-Za-z0-9_:-]{1,200}", key):
            raise NativeError("Invalid request identity")
        operation = Operation(action)
        audio = base64.b64decode(encoded, validate=True)
        if len(audio) > MAX_PCM_BYTES or len(audio) % 2:
            raise NativeError("Invalid PCM length")
        if operation is Operation.PUSH and not audio:
            raise NativeError("Empty PCM")
        return cls(RequestId(ident), operation, StreamKey(key), audio)


def emit(value: str) -> None:
    _ = sys.stdout.write(value + "\n")
    _ = sys.stdout.flush()


def run() -> None:
    directory = Path(sys.argv[1]).resolve()
    geometry = Geometry(chunk=int(sys.argv[CHUNK_ARG_INDEX]) if len(sys.argv) > CHUNK_ARG_INDEX else 64)
    started = time.monotonic()
    model = NativeModel(directory, geometry)
    sample_counts: dict[StreamKey, int] = {}
    emit(
        json.dumps(
            {
                "ready": True,
                "speakers": 8,
                "backend": "cpu",
                "shared_model": True,
                "preset": "v3-streaming",
                "geometry": asdict(geometry),
                "startup_ms": (time.monotonic() - started) * 1000,
            }
        )
    )
    try:
        while line := sys.stdin.readline(LIMIT + 1):
            request_id = line.split("\t", 1)[0]
            try:
                request = Request.parse(line)
                start = time.monotonic()
                turns = []
                processed = 0.0
                match request.operation:
                    case Operation.OPEN:
                        model.open(request.key)
                        sample_counts[request.key] = 0
                    case Operation.PUSH:
                        pcm = array.array("h")
                        pcm.frombytes(request.audio)
                        if sys.byteorder != "little":
                            pcm.byteswap()
                        model.push(request.key, [value / 32768.0 for value in pcm])
                        sample_counts[request.key] += len(pcm)
                        processed, turns = model.results(request.key, max(0, sample_counts[request.key] / 16000 - 32))
                    case Operation.FINISH:
                        model.finish(request.key)
                        processed, turns = model.results(request.key, max(0, sample_counts[request.key] / 16000 - 32))
                    case Operation.CLOSE:
                        model.release(request.key)
                        _ = sample_counts.pop(request.key, None)
                    case _:
                        assert_never(request.operation)
                emit(
                    json.dumps(
                        {
                            "id": request.id,
                            "key": request.key,
                            "processed_s": processed,
                            "segments": [asdict(turn) for turn in turns],
                            "inference_ms": (time.monotonic() - start) * 1000,
                        }
                    )
                )
            except (NativeError, ValueError, binascii.Error, KeyError) as error:
                emit(json.dumps({"id": request_id, "error": str(error)}))
    finally:
        model.close()


if __name__ == "__main__":
    run()
