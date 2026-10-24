"""CPU-only, meeting-local offline diarization and voice features; no network access."""

from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypedDict

import numpy as np
import sherpa_onnx
from numpy.typing import NDArray

RATE: Final = 16000
METHOD: Final = "offline-pyannote-wespeaker-v1"


@dataclass(frozen=True, slots=True)
class SpeechTurn:
    start: float
    end: float
    speaker: int


class Feature(TypedDict):
    segment_id: str
    session_id: str
    cluster: str
    voiced_s: float
    purity: float
    mixed: bool
    vector: list[float]


def emit(completed: int, total: int) -> None:
    print(json.dumps({"completed": completed, "total": total}), flush=True)


def row_feature(
    segment_id: str, session_id: str, start: float, end: float,
    turns: list[SpeechTurn], audio: NDArray[np.float32],
    extractor: sherpa_onnx.SpeakerEmbeddingExtractor,
) -> Feature | None:
    """Use only one person's clean speech and refuse rows that contain a speaker change."""
    local = [SpeechTurn(max(start, t.start), min(end, t.end), t.speaker)
             for t in turns if t.end > start and t.start < end]
    durations: dict[int, float] = {}
    for turn in local:
        durations[turn.speaker] = durations.get(turn.speaker, 0.0) + turn.end - turn.start
    if not durations:
        return None
    ranked = sorted(durations.items(), key=lambda item: item[1], reverse=True)
    speaker, seconds = ranked[0]
    overlap = any(a.speaker != b.speaker and min(a.end, b.end) - max(a.start, b.start) > 0.2
                  for i, a in enumerate(local) for b in local[i + 1:])
    mixed = overlap or (len(ranked) > 1 and ranked[1][1] >= 0.5)
    purity = seconds / sum(durations.values())
    pieces = [audio[int(t.start * RATE):int(t.end * RATE)] for t in local if t.speaker == speaker]
    samples = np.concatenate(pieces)[:RATE * 20]
    if mixed or len(samples) < RATE * 2 or float(np.sqrt(np.mean(samples ** 2))) < 0.001:
        return {"segment_id": segment_id, "session_id": session_id, "cluster": f"voice-{speaker}",
                "voiced_s": min(seconds, end - start), "purity": purity, "mixed": True, "vector": [0.0] * 256}
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=RATE, waveform=samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        return None
    vector = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if vector.shape != (256,) or norm == 0 or not np.isfinite(vector).all():
        raise RuntimeError("Invalid voice feature")
    return {"segment_id": segment_id, "session_id": session_id, "cluster": f"voice-{speaker}",
            "voiced_s": min(seconds, end - start), "purity": purity, "mixed": False,
            "vector": [round(float(x), 7) for x in vector / norm]}


def run(request_file: Path, output_file: Path) -> None:
    """Read a private manifest created by Node; output features without names or transcript text."""
    request = json.loads(request_file.read_text(encoding="utf-8"))
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=request["segmentation"], window_shift_ratio=0.5),
            num_threads=2, provider="cpu",
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=request["embedding"], num_threads=2, provider="cpu"),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.5),
        min_duration_on=0.3, min_duration_off=0.3,
    )
    if not config.validate():
        raise RuntimeError("Invalid offline speaker configuration")
    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config.embedding)
    if extractor.dim != 256:
        raise RuntimeError("Unexpected embedding dimension")
    started = time.monotonic()
    features = []
    stats = []
    recordings = request["recordings"]
    for index, recording in enumerate(recordings):
        path = Path(recording["file"])
        if path.stat().st_size != recording["bytes"] or recording["bytes"] > 32000 * 21600:
            raise RuntimeError("Recording changed or exceeds six hours")
        audio = np.fromfile(path, dtype="<i2").astype(np.float32) / 32768.0

        def progress(done: int, total: int, session_index: int = index) -> int:
            emit(session_index * 1000 + int(done / max(total, 1) * 800), len(recordings) * 1000)
            return 0

        result = diarizer.process(audio, callback=progress).sort_by_start_time()
        turns = [SpeechTurn(float(t.start), min(float(t.end), len(audio) / RATE), int(t.speaker)) for t in result]
        session_rows = [row for row in request["rows"] if row["session_id"] == recording["session_id"] and row["timeline_epoch"] == 0]
        for position, row in enumerate(session_rows):
            start, end = row["start_ms"] / 1000, row["end_ms"] / 1000
            if start < 0 or end <= start or end > len(audio) / RATE + 0.1:
                continue
            feature = row_feature(row["segment_id"], row["session_id"], start, end, turns, audio, extractor)
            if feature:
                features.append(feature)
            if position % 20 == 0:
                emit(index * 1000 + 800 + int(position / max(len(session_rows), 1) * 200), len(recordings) * 1000)
        stats.append({"session_id": recording["session_id"], "seconds": len(audio) / RATE,
                      "speakers": len({t.speaker for t in turns}), "turns": len(turns)})
        emit((index + 1) * 1000, len(recordings) * 1000)
    output_file.write_text(json.dumps({"method": METHOD, "features": features,
                                      "stats": {"sessions": stats, "elapsed_s": time.monotonic() - started,
                                                "provider": "cpu", "threads": 2}}, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    run(Path(sys.argv[1]), Path(sys.argv[2]))
