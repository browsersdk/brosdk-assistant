#!/usr/bin/env python3
"""Run a real DeepSeek request through the Rust Native Messaging host.

The API key is read from DEEPSEEK_API_KEY and is never written to the repository
or printed. Settings are persisted under a temporary APPDATA/HOME directory.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
NATIVE_DIR = ROOT / "native-host"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-flash"
MAX_MESSAGE_BYTES = 16 * 1024 * 1024


def command_name(name: str) -> str:
    if os.name == "nt" and shutil.which(f"{name}.exe"):
        return f"{name}.exe"
    return name


def native_binary(release: bool) -> Path:
    profile = "release" if release else "debug"
    suffix = ".exe" if os.name == "nt" else ""
    return NATIVE_DIR / "target" / profile / f"brosdk-assistant-native{suffix}"


def build_native(release: bool) -> None:
    command = [command_name("cargo"), "build"]
    if release:
        command.append("--release")
    subprocess.run(command, cwd=NATIVE_DIR, check=True)


def redact(value: str, secret: str) -> str:
    return value.replace(secret, "<redacted>") if secret else value


class NativeHost:
    def __init__(self, executable: Path, environment: dict[str, str], secret: str):
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.secret = secret
        self.process = subprocess.Popen(
            [str(executable)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            creationflags=creationflags,
        )
        self.messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()
        self.deferred_messages: list[dict[str, Any]] = []
        self.stderr_lines: list[str] = []
        self.reader = threading.Thread(target=self._read_messages, daemon=True)
        self.stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self.reader.start()
        self.stderr_reader.start()

    def _read_messages(self) -> None:
        try:
            while True:
                length_bytes = self._read_exact(4)
                if length_bytes is None:
                    return
                length = struct.unpack("<I", length_bytes)[0]
                if length > MAX_MESSAGE_BYTES:
                    raise RuntimeError(f"native message too large: {length} bytes")
                payload = self._read_exact(length)
                if payload is None:
                    raise RuntimeError("native host closed while reading a message")
                self.messages.put(json.loads(payload.decode("utf-8")))
        except BaseException as error:
            self.messages.put(error)

    def _read_exact(self, size: int) -> bytes | None:
        assert self.process.stdout is not None
        data = bytearray()
        while len(data) < size:
            chunk = self.process.stdout.read(size - len(data))
            if not chunk:
                return None if not data else bytes(data)
            data.extend(chunk)
        return bytes(data)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in iter(self.process.stderr.readline, b""):
            self.stderr_lines.append(redact(line.decode("utf-8", errors="replace"), self.secret))

    def send(self, value: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.process.stdin.write(struct.pack("<I", len(payload)))
        self.process.stdin.write(payload)
        self.process.stdin.flush()

    def receive(self, timeout: float) -> dict[str, Any]:
        if self.deferred_messages:
            return self.deferred_messages.pop(0)
        try:
            message = self.messages.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError(f"native host did not respond within {timeout:.0f}s") from error
        if isinstance(message, BaseException):
            raise RuntimeError(str(message)) from message
        return message

    def wait_for_event(self, event: str, timeout: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        deferred = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"timed out waiting for event {event}")
                message = self.receive(remaining)
                if message.get("event") == event:
                    return message
                deferred.append(message)
        finally:
            self.deferred_messages = deferred + self.deferred_messages

    def request(self, method: str, params: dict[str, Any] | None, timeout: float) -> Any:
        request_id = f"e2e-{uuid.uuid4()}"
        self.send({"id": request_id, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        deferred = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"timed out waiting for {method}")
                message = self.receive(remaining)
                if message.get("event") == "extension.tool.request":
                    raise RuntimeError("unexpected extension tool request while browser tools are off")
                if message.get("id") != request_id:
                    deferred.append(message)
                    continue
                if message.get("error"):
                    error = message["error"]
                    raise RuntimeError(f"{method} failed: {error.get('message', error)}")
                return message.get("result")
        finally:
            self.deferred_messages = deferred + self.deferred_messages

    def wait_for_run(self, run_id: str, timeout: float) -> tuple[str, Any, list[dict[str, Any]]]:
        deadline = time.monotonic() + timeout
        events = []
        deferred = []
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"timed out waiting for run {run_id}")
                message = self.receive(remaining)
                payload = message.get("payload") or {}
                if payload.get("run_id") != run_id:
                    deferred.append(message)
                    continue
                events.append(message)
                event = message.get("event")
                if event == "agent.done":
                    return "done", payload.get("result"), events
                if event == "agent.cancelled":
                    return "cancelled", None, events
                if event == "agent.error":
                    error = payload.get("error") or {}
                    raise RuntimeError(f"agent run failed: {error.get('message', error)}")
        finally:
            self.deferred_messages = deferred + self.deferred_messages

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def diagnostics(self) -> str:
        return "".join(self.stderr_lines).strip()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run_test(args: argparse.Namespace, api_key: str) -> None:
    executable = native_binary(args.release)
    if not args.skip_build:
        build_native(args.release)
    if not executable.exists():
        raise RuntimeError(f"native host executable not found: {executable}")

    verification_token = f"BSDK-{uuid.uuid4().hex[:12].upper()}"
    with tempfile.TemporaryDirectory(prefix="brosdk-deepseek-e2e-") as temp_dir:
        workspace = Path(temp_dir) / "workspace"
        workspace.mkdir()
        (workspace / "verification.txt").write_text(
            f"verification token: {verification_token}\n",
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment["APPDATA"] = temp_dir
        environment["HOME"] = temp_dir
        host = NativeHost(executable, environment, api_key)
        try:
            ready = host.wait_for_event("native.ready", args.timeout)
            require(ready.get("payload", {}).get("service") == "brosdk-assistant-native", "invalid ready event")
            print("PASS native.ready")

            health = host.request("agent.health", None, args.timeout)
            require(health.get("ok") is True, "agent.health did not report ok")
            print(f"PASS agent.health version={health.get('version')}")

            settings = host.request(
                "settings.set",
                {
                    "workspace_dir": str(workspace),
                    "browser_tools_mode": "off",
                    "open_side_panel_on_action_click": True,
                    "side_panel_per_window": True,
                    "mcp_url": "",
                    "model_base_url": args.base_url,
                    "model_name": args.model,
                    "model_api_type": "openai",
                    "api_key": api_key,
                    "temperature": 0.0,
                },
                args.timeout,
            )
            require(settings.get("configured") is True, "temporary settings were not configured")
            require(settings.get("browser_tools_mode") == "off", "browser tools were not disabled")
            print(f"PASS settings.set model={args.model} browser_tools=off workspace=scoped")

            first_prompt = (
                "This is an automated end-to-end test. Use workspace_read_file to read "
                "verification.txt, then return only the verification token from that file."
            )
            first_start = host.request(
                "agent.start",
                {"message": first_prompt, "history": [], "mode": "chat"},
                args.timeout,
            )
            first_run_id = str(first_start.get("run_id", ""))
            require(first_run_id, "agent.start did not return a run id")
            health_started = time.monotonic()
            concurrent_health = host.request("agent.health", None, args.timeout)
            health_latency = time.monotonic() - health_started
            require(concurrent_health.get("ok") is True, "concurrent agent.health failed")
            require(health_latency < 5.0, "agent.health was blocked by an active run")
            first_state, first, first_events = host.wait_for_run(first_run_id, args.timeout)
            require(first_state == "done", "first async run did not complete")
            first_answer = str(first.get("message", ""))
            require(first_answer.strip(), "first model response was empty")
            require(first.get("workspace_tool_count") == 3, "chat workspace tools were not exposed")
            tool_results = first.get("tool_results") or []
            require(
                any(result.get("tool_name") == "workspace_read_file" for result in tool_results),
                "model did not call workspace_read_file",
            )
            event_names = [event.get("event") for event in first_events]
            require("agent.status" in event_names, "run did not emit status events")
            require("agent.delta" in event_names, "run did not emit model deltas")
            require("agent.tool.started" in event_names, "run did not emit tool start")
            require("agent.tool.finished" in event_names, "run did not emit tool finish")
            streamed_text = "".join(
                str((event.get("payload") or {}).get("delta", ""))
                for event in first_events
                if event.get("event") == "agent.delta"
            )
            require(
                verification_token.lower() in streamed_text.lower(),
                "streamed deltas did not contain the final verification token",
            )
            require(
                verification_token.lower() in first_answer.lower(),
                "workspace-backed response did not contain the verification token",
            )
            print(
                "PASS agent.start workspace_tool "
                f"tool_calls={len(tool_results)} chars={len(first_answer)} "
                f"concurrent_health_ms={health_latency * 1000:.0f}"
            )

            second_prompt = "Return only the verification token from the previous turn."
            second_start = host.request(
                "agent.start",
                {
                    "message": second_prompt,
                    "history": [
                        {"role": "user", "content": first_prompt},
                        {"role": "assistant", "content": first_answer},
                    ],
                    "mode": "chat",
                },
                args.timeout,
            )
            second_run_id = str(second_start.get("run_id", ""))
            require(second_run_id, "second agent.start did not return a run id")
            second_state, second, _second_events = host.wait_for_run(second_run_id, args.timeout)
            require(second_state == "done", "second async run did not complete")
            second_answer = str(second.get("message", ""))
            require(
                verification_token.lower() in second_answer.lower(),
                "second response did not preserve multi-turn context",
            )
            print(f"PASS agent.start multi_turn token={verification_token}")

            cancel_start = host.request(
                "agent.start",
                {
                    "message": "Write a detailed 2000-word explanation of browser automation.",
                    "history": [],
                    "mode": "chat",
                },
                args.timeout,
            )
            cancel_run_id = str(cancel_start.get("run_id", ""))
            require(cancel_run_id, "cancel test did not return a run id")
            cancel_result = host.request(
                "agent.cancel",
                {"run_id": cancel_run_id},
                args.timeout,
            )
            require(cancel_result.get("state") == "cancelled", "agent.cancel was not acknowledged")
            cancel_state, _cancelled_result, _cancel_events = host.wait_for_run(
                cancel_run_id,
                args.timeout,
            )
            require(cancel_state == "cancelled", "cancelled event was not emitted")
            print("PASS agent.cancel acknowledged_and_emitted")
        finally:
            host.close()
            diagnostics = host.diagnostics()
            if diagnostics:
                print("Native host diagnostics:", file=sys.stderr)
                print(diagnostics, file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run DeepSeek E2E through the native host.")
    parser.add_argument("--base-url", default=os.getenv("DEEPSEEK_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--model", default=os.getenv("DEEPSEEK_MODEL", DEFAULT_MODEL))
    parser.add_argument("--timeout", type=float, default=240.0)
    parser.add_argument("--release", action="store_true", help="Test the release native binary.")
    parser.add_argument("--skip-build", action="store_true", help="Use an existing native binary.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    api_key = os.getenv("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        print("DEEPSEEK_API_KEY is required", file=sys.stderr)
        return 2
    try:
        run_test(args, api_key)
    except subprocess.CalledProcessError as error:
        print(f"Build failed with exit code {error.returncode}", file=sys.stderr)
        return error.returncode
    except Exception as error:
        print(f"DeepSeek E2E failed: {redact(str(error), api_key)}", file=sys.stderr)
        return 1
    print("DeepSeek E2E passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
