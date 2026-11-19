#!/usr/bin/env python3
"""Receive pre-sanitized, per-machine signed metrics and serve recent snapshots."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import threading
import time

SIGNATURE = re.compile(r"[a-f0-9]{64}")
INGEST = re.compile(r"/api/ingest/([1-4])")
KEYS = {i: bytes.fromhex(os.environ[f"COLLECTOR_TOKEN_{i}"]) for i in range(1, 5)}
MAX_PAYLOAD = 16 * 1024
SNAPSHOTS = {}
LOCK = threading.Lock()

def timestamp_ms():
    return time.time_ns() // 1_000_000

class RelayHandler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def respond(self, status, payload=b""):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def log_message(self, format_string, *args):
        return

    def do_GET(self):
        if self.path != "/v1/metrics":
            return self.respond(404)
        cutoff = timestamp_ms() - 90_000
        with LOCK:
            records = [record for record in SNAPSHOTS.values() if record["timestamp"] > cutoff]
        self.respond(200, json.dumps({"records": records}, separators=(",", ":")).encode())

    def do_POST(self):
        match = INGEST.fullmatch(self.path)
        if not match:
            return self.respond(404)
        machine = int(match[1])
        time_header = self.headers.get("X-NPU-Timestamp", "")
        signature = self.headers.get("X-NPU-Signature", "")
        length = self.headers.get("Content-Length", "")
        if not re.fullmatch(r"\d{1,5}", length) or not 0 < int(length) <= MAX_PAYLOAD:
            return self.respond(400)
        if not re.fullmatch(r"\d{13}", time_header) or not SIGNATURE.fullmatch(signature):
            return self.respond(401)
        sent = int(time_header)
        if abs(timestamp_ms() - sent) > 60_000:
            return self.respond(401)

        try:
            sample = self.rfile.read(int(length))
        except (OSError, TimeoutError):
            return self.respond(408)
        signed = time_header.encode() + b"\n" + sample
        expected = hmac.new(KEYS[machine], signed, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return self.respond(401)
        try:
            content = sample.decode("utf-8")
            if not isinstance(json.loads(content), dict):
                return self.respond(400)
        except (ValueError, UnicodeError):
            return self.respond(400)
        with LOCK:
            if sent > SNAPSHOTS.get(machine, {}).get("timestamp", 0):
                SNAPSHOTS[machine] = {"machine": machine, "timestamp": sent, "sample": content, "signature": signature}
        self.respond(204)

class RelayServer(ThreadingHTTPServer):
    request_queue_size = 32
    slots = threading.BoundedSemaphore(24)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

if __name__ == "__main__":
    host = os.environ.get("NPU_RELAY_BIND", "127.0.0.1")
    port = int(os.environ.get("NPU_RELAY_PORT", "8080"))
    with RelayServer((host, port), RelayHandler) as http:
        http.serve_forever()
