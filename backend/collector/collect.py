#!/usr/bin/env python3
"""Read host and Ascend 950DT metrics, then upload the sanitized snapshot."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROW = re.compile(r"^\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$")
DEVICE = re.compile(r"^[A-Za-z0-9._ -]{1,50}$")
COMPUTE = re.compile(r"^(\d+|NA|N/A|--)\s+(\d+|NA|N/A|--)\s*/\s*(\d+|NA|N/A|--)\s+(\d+|NA|N/A|--)\s*/\s*(\d+|NA|N/A|--)$")
PROCESS = re.compile(r"^\s*\|\s*(\d+)\s*\|\s*\d+\s*\|")
NO_PROCESS = re.compile(r"No running processes found in NPU\s+(\d+)")

def number(value):
    return int(value) if value.isdecimal() else None

def parse_npu(output):
    cards = {}
    processes = {}
    pending = None
    in_process_table = False
    for line in output.splitlines():
        if "Process id" in line and "Process memory" in line:
            in_process_table = True
            continue
        if in_process_table:
            row = PROCESS.match(line)
            empty = NO_PROCESS.search(line)
            if row:
                card_id = int(row[1])
                processes[card_id] = processes.get(card_id, 0) + 1
            elif empty:
                processes.setdefault(int(empty[1]), 0)
            continue

        row = ROW.match(line)
        if not row:
            continue
        card_id, model, detail, raw = row.groups()
        if card_id.isdecimal() and DEVICE.fullmatch(model):
            values = raw.split()
            temperature = number(values[1]) if len(values) > 1 else None
            pending = {"id": int(card_id), "health": "ok" if detail == "OK" else "warning",
                       "temperature": temperature}
        elif pending and not card_id:
            reading = COMPUTE.fullmatch(raw)
            pending["utilization"] = number(reading[1]) if reading else None
            pending["hbmUsed"] = number(reading[4]) if reading else None
            pending["hbmTotal"] = number(reading[5]) if reading else None
            cards[pending["id"]] = pending
            pending = None

    for card_id, card in cards.items():
        card["processes"] = processes.get(card_id)
    return sorted(cards.values(), key=lambda card: card["id"])

def cpu_time():
    with open("/proc/stat", encoding="ascii") as stat:
        values = [int(value) for value in stat.readline().split()[1:9]]
    return sum(values), values[3] + values[4]

def memory_usage():
    memory = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        name, value = line.split(":", 1)
        if name in ("MemTotal", "MemAvailable"):
            memory[name] = int(value.split()[0])
    return round(100 * (1 - memory["MemAvailable"] / memory["MemTotal"]), 1)

def take_sample():
    start, start_idle = cpu_time()
    time.sleep(1)
    end, end_idle = cpu_time()
    cpu = round(100 * (1 - (end_idle - start_idle) / (end - start)), 1) if end > start else None
    disk = shutil.disk_usage("/")
    cards = None
    try:
        result = subprocess.run(
            ["/usr/local/sbin/npu-smi", "info"], text=True, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, check=True, timeout=10, env={**os.environ, "LC_ALL": "C"})
        cards = parse_npu(result.stdout)
        if not cards:
            print("NPU output contained no parseable cards", file=sys.stderr)
    except (OSError, subprocess.SubprocessError) as error:
        print("NPU metrics unavailable: " + type(error).__name__, file=sys.stderr)
    return {"cpu": cpu, "memory": memory_usage(), "disk": round(100 * disk.used / disk.total, 1),
            "cards": cards}

def main():
    sample = take_sample()
    if sys.argv[1:] == ["--sample"]:
        print(json.dumps(sample))
        return 0
    endpoint = os.environ["NPU_BOARD_ENDPOINT"]
    payload = json.dumps(sample, separators=(",", ":")).encode()
    token = os.environ["NPU_BOARD_TOKEN"]
    headers = {"Content-Type": "application/json"}
    if os.environ.get("NPU_BOARD_TRANSPORT") == "relay":
        if not endpoint.startswith(("https://", "http://")):
            raise ValueError("A relay endpoint must use HTTP or HTTPS")
        timestamp = str(time.time_ns() // 1_000_000)
        signed = timestamp.encode() + b"\n" + payload
        headers["X-NPU-Timestamp"] = timestamp
        headers["X-NPU-Signature"] = hmac.new(bytes.fromhex(token), signed, hashlib.sha256).hexdigest()
    else:
        if not endpoint.startswith("https://"):
            raise ValueError("The upload endpoint must use HTTPS")
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(endpoint, payload, method="POST", headers=headers)
    # Never forward a machine token on a redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=12) as response:
            return 0 if response.status == 204 else 1
    except urllib.error.HTTPError as error:
        print("Upload rejected (HTTP " + str(error.code) + ")", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError) as error:
        print("Upload connection failed: " + type(error).__name__, file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
