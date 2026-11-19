"""Publish a sanitized snapshot atomically for the restricted SSH reader."""
import json
import os
from pathlib import Path
import tempfile
import time

from collect import take_sample

directory = Path("/var/lib/npu-board-cache")
sample = take_sample()
if not sample["cards"] or len(sample["cards"]) != 8:
    raise SystemExit("expected eight NPU cards")
record = {"sampledAt": time.time_ns() // 1_000_000, "sample": sample}
with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as pending:
    json.dump(record, pending, separators=(",", ":"))
    pending.write("\n")
    os.fchmod(pending.fileno(), 0o644)
os.replace(pending.name, directory / "latest.json")
