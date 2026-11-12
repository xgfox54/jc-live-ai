import base64
import json
import sys
from typing import Final

import numpy as np
import onnxruntime as ort

FRAME: Final = 512
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
model = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    pcm = base64.b64decode(request["pcm"], validate=True)
    if not pcm or len(pcm) % 2 or len(pcm) > 960000:
        raise ValueError("Invalid PCM frame")
    counts = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    samples = counts / 32768.0
    noise_floor = bool(len(counts) >= 8000 and np.max(np.abs(counts)) <= 48)
    if noise_floor:
        lengths = np.arange(0, len(counts), 320)
        sizes = np.minimum(320, len(counts) - lengths)
        means = np.add.reduceat(counts, lengths) / sizes
        variance = np.add.reduceat(counts * counts, lengths) / sizes - means * means
        noise_floor = bool(np.max(variance) <= 12 ** 2)
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    peak = 0.0
    for start in range(0, len(samples), FRAME):
        block = samples[start:start + FRAME]
        block = np.pad(block, (0, FRAME - len(block))).reshape(1, FRAME)
        probability, state = model.run(None, {"input": np.concatenate((context, block), axis=1),
            "state": state, "sr": np.array(16000, dtype=np.int64)})
        context = block[:, -64:]
        peak = max(peak, float(probability[0, 0]))
    print(json.dumps({"id": request["id"], "peak": peak, "noise_floor": noise_floor}), flush=True)
