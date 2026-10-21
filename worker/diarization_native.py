# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
from __future__ import annotations

import ctypes as ct
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, Protocol, TypeAlias, cast, final

if TYPE_CHECKING:
    from pathlib import Path

MAX_SPEAKERS: Final = 8
MAX_STREAMS: Final = 8
MAX_SEGMENTS: Final = 200000
NativeCType: TypeAlias = (
    type[ct.c_void_p]
    | type[ct.c_int]
    | type[ct.c_int32]
    | type[ct.c_size_t]
    | type[ct.c_int64]
    | type[ct.c_double]
    | type[ct.c_char_p]
)
NativeValue: TypeAlias = int | float | bytes | None


class NativeFunction(Protocol):
    argtypes: list[NativeCType]
    restype: NativeCType | None

    def __call__(self, *arguments: ct.c_void_p | int | None) -> NativeValue: ...


class NativeError(RuntimeError):
    pass


@final
class ModelConfig(ct.Structure):
    _fields_ = [
        ("size", ct.c_size_t),
        ("model_path", ct.c_char_p),
        ("gpu", ct.c_int32),
        ("preset", ct.c_char_p),
        ("chunk_frames", ct.c_int32),
        ("right_context_frames", ct.c_int32),
        ("left_context_frames", ct.c_int32),
        ("fifo_frames", ct.c_int32),
        ("spkcache_frames", ct.c_int32),
        ("update_period_frames", ct.c_int32),
    ]


@final
class Segment(ct.Structure):
    _fields_ = [("start_time", ct.c_double), ("end_time", ct.c_double), ("speaker", ct.c_int32)]


@dataclass(frozen=True, slots=True)
class Geometry:
    chunk: int = 64
    right_context: int = 4
    fifo: int = 80
    cache: int = 264
    update: int = 40


@dataclass(frozen=True, slots=True)
class Turn:
    start: float
    end: float
    speaker: int


@final
class NativeModel:
    """Own one shared model and explicitly managed independent stream handles."""

    def __init__(self, directory: Path, geometry: Geometry) -> None:
        self.directory_handle = os.add_dll_directory(str(directory))
        self.library = ct.CDLL(str(directory / "nemo_speech_asr_c.dll"))
        self.streams: dict[str, ct.c_void_p] = {}
        prototypes: dict[str, tuple[list[NativeCType], NativeCType | None]] = {
            "nemo_speech_diar_create": ([ct.c_void_p, ct.c_void_p], ct.c_int),
            "nemo_speech_diar_destroy": ([ct.c_void_p], None),
            "nemo_speech_diar_num_speakers": ([ct.c_void_p], ct.c_int32),
            "nemo_speech_diar_seconds_per_frame": ([ct.c_void_p], ct.c_double),
            "nemo_speech_diar_stream_open": ([ct.c_void_p, ct.c_void_p], ct.c_int),
            "nemo_speech_diar_stream_push_f32": ([ct.c_void_p, ct.c_void_p, ct.c_size_t, ct.c_int32], ct.c_int),
            "nemo_speech_diar_stream_finish": ([ct.c_void_p], ct.c_int),
            "nemo_speech_diar_stream_close": ([ct.c_void_p], None),
            "nemo_speech_diar_frame_count": ([ct.c_void_p], ct.c_int64),
            "nemo_speech_diar_segments": ([ct.c_void_p, ct.c_void_p, ct.c_void_p, ct.c_size_t, ct.c_void_p], ct.c_int),
            "nemo_speech_asr_last_error": ([], ct.c_char_p),
        }
        self.functions: dict[str, NativeFunction] = {}
        for name, (arguments, result) in prototypes.items():
            function = cast("NativeFunction", getattr(self.library, name))
            function.argtypes = arguments
            function.restype = result
            self.functions[name] = function
        self.model = ct.c_void_p()
        config = ModelConfig()
        config.size = ct.sizeof(config)
        config.model_path = str(directory / "Nemotron-3-Diarization.q8_0.gguf").encode()
        config.gpu = -1
        config.preset = b"v3-streaming"
        config.chunk_frames = geometry.chunk
        config.right_context_frames = geometry.right_context
        config.left_context_frames = -1
        config.fifo_frames = geometry.fifo
        config.spkcache_frames = geometry.cache
        config.update_period_frames = geometry.update
        self.check(
            cast(
                "int",
                self.functions["nemo_speech_diar_create"](
                    ct.cast(ct.byref(config), ct.c_void_p), ct.cast(ct.byref(self.model), ct.c_void_p)
                ),
            )
        )
        if self.functions["nemo_speech_diar_num_speakers"](self.model) != MAX_SPEAKERS:
            self.close()
            raise NativeError("Expected an eight-speaker model")
        self.frame_seconds = cast("float", self.functions["nemo_speech_diar_seconds_per_frame"](self.model))

    def check(self, status: int) -> None:
        if status != 0:
            message = cast("bytes | None", self.functions["nemo_speech_asr_last_error"]())
            message = message or b"Native diarization failed"
            raise NativeError(message.decode("utf-8", errors="replace"))

    def open(self, key: str) -> None:
        if key in self.streams:
            raise NativeError("Stream already open")
        if len(self.streams) >= MAX_STREAMS:
            raise NativeError("Eight-stream capacity exceeded")
        handle = ct.c_void_p()
        self.check(
            cast(
                "int",
                self.functions["nemo_speech_diar_stream_open"](self.model, ct.cast(ct.byref(handle), ct.c_void_p)),
            )
        )
        self.streams[key] = handle

    def push(self, key: str, samples: list[float]) -> None:
        audio = (ct.c_float * len(samples))(*samples)
        self.check(
            cast(
                "int",
                self.functions["nemo_speech_diar_stream_push_f32"](
                    self.streams[key], ct.cast(audio, ct.c_void_p), len(samples), 16000
                ),
            )
        )

    def finish(self, key: str) -> None:
        self.check(cast("int", self.functions["nemo_speech_diar_stream_finish"](self.streams[key])))

    def results(self, key: str, since: float) -> tuple[float, list[Turn]]:
        handle = self.streams[key]
        count = ct.c_size_t()
        self.check(
            cast(
                "int",
                self.functions["nemo_speech_diar_segments"](
                    handle, None, None, 0, ct.cast(ct.byref(count), ct.c_void_p)
                ),
            )
        )
        if count.value > MAX_SEGMENTS:
            raise NativeError("Speaker segment limit exceeded")
        segments = (Segment * count.value)()
        self.check(
            cast(
                "int",
                self.functions["nemo_speech_diar_segments"](
                    handle, None, ct.cast(segments, ct.c_void_p), count.value, ct.cast(ct.byref(count), ct.c_void_p)
                ),
            )
        )
        turns: list[Turn] = []
        for index in range(count.value):
            row = cast("Segment", segments[index])
            start = cast("float", row.start_time)
            end = cast("float", row.end_time)
            speaker = cast("int", row.speaker)
            if end > since:
                turns.append(Turn(start, end, speaker))
        processed = cast("int", self.functions["nemo_speech_diar_frame_count"](handle)) * self.frame_seconds
        return processed, turns

    def release(self, key: str) -> None:
        handle = self.streams.pop(key, None)
        if handle:
            _ = self.functions["nemo_speech_diar_stream_close"](handle)

    def close(self) -> None:
        for key in list(self.streams):
            self.release(key)
        _ = self.functions["nemo_speech_diar_destroy"](self.model)
        self.directory_handle.close()
