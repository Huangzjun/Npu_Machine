"""The forced SSH command returns only the latest sanitized sample."""
import json
from pathlib import Path
import time

record = json.loads(Path("/var/lib/npu-board-cache/latest.json").read_text(encoding="utf-8"))
age_ms = time.time_ns() // 1_000_000 - record["sampledAt"]
if not 0 <= age_ms <= 75_000:
    raise SystemExit("no recent sample")
print(json.dumps({"ageMs": age_ms, "sample": record["sample"]}, separators=(",", ":")))
