#!/usr/bin/env python3
"""Run a deterministic Native Messaging and extension-tool E2E test."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from test_deepseek_e2e import NativeHost, build_native, native_binary, require


class MockOpenAIState:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.first_request_received = threading.Event()
        self.release_first_response = threading.Event()

    def response_for(self, body: dict[str, Any]) -> list[dict[str, Any] | str]:
        self.requests.append(body)
        request_index = len(self.requests)
        if request_index == 1:
            self.first_request_received.set()
            if not self.release_first_response.wait(timeout=10):
                raise RuntimeError("timed out waiting to release mock model response")
            tool_names = {
                tool.get("function", {}).get("name")
                for tool in body.get("tools", [])
                if isinstance(tool, dict)
            }
            require("browser_active_tab" in tool_names, "extension browser tools were not sent")
            return [
                {
                    "choices": [
                        {
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call-active-tab",
                                        "type": "function",
                                        "function": {
                                            "name": "browser_active_tab",
                                            "arguments": "{}",
                                        },
                                    }
                                ],
                            }
                        }
                    ]
                },
                "[DONE]",
            ]

        tool_messages = [message for message in body.get("messages", []) if message.get("role") == "tool"]
        require(tool_messages, "second model request did not contain a tool result")
        tool_result = json.loads(tool_messages[-1].get("content", "{}"))
        require(tool_result.get("tab", {}).get("tabId") == 42, "tool result lost the tab id")
        return [
            {"choices": [{"delta": {"content": "Active tab: "}}]},
            {"choices": [{"delta": {"content": "Protocol Test"}}]},
            {"choices": [{"delta": {"content": " (tabId 42)"}}]},
            "[DONE]",
        ]


class MockOpenAIHandler(BaseHTTPRequestHandler):
    server: "MockOpenAIServer"

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        require(self.headers.get("authorization") == "Bearer mock-key", "missing model authorization")
        events = self.server.state.response_for(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for event in events:
            data = event if isinstance(event, str) else json.dumps(event, separators=(",", ":"))
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class MockOpenAIServer(ThreadingHTTPServer):
    def __init__(self, state: MockOpenAIState):
        super().__init__(("127.0.0.1", 0), MockOpenAIHandler)
        self.state = state


def run_test(args: argparse.Namespace) -> None:
    executable = native_binary(args.release)
    if not args.skip_build:
        build_native(args.release)
    if not executable.exists():
        raise RuntimeError(f"native host executable not found: {executable}")

    state = MockOpenAIState()
    server = MockOpenAIServer(state)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}/v1"

    def extension_tool_handler(payload: dict[str, Any]) -> Any:
        require(payload.get("name") == "browser_active_tab", "unexpected extension tool name")
        return {
            "tab": {
                "tabId": 42,
                "windowId": 7,
                "active": True,
                "title": "Protocol Test",
                "url": "https://example.test/protocol",
            }
        }

    try:
        with tempfile.TemporaryDirectory(prefix="brosdk-native-protocol-e2e-") as temp_dir:
            environment = os.environ.copy()
            environment["APPDATA"] = temp_dir
            environment["HOME"] = temp_dir
            host = NativeHost(
                executable,
                environment,
                "mock-key",
                extension_tool_handler=extension_tool_handler,
            )
            try:
                ready = host.wait_for_event("native.ready", args.timeout)
                require(ready.get("payload", {}).get("service") == "brosdk-assistant-native", "invalid ready event")
                print("PASS native.ready")

                settings = host.request(
                    "settings.set",
                    {
                        "workspace_dir": "",
                        "browser_tools_mode": "extension",
                        "mcp_url": "",
                        "model_base_url": base_url,
                        "model_name": "mock-model",
                        "model_api_type": "openai",
                        "api_key": "mock-key",
                        "temperature": 0.0,
                    },
                    args.timeout,
                )
                require(settings.get("configured") is True, "mock model settings were not configured")
                print("PASS settings.set mock_provider")

                started = host.request(
                    "agent.start",
                    {
                        "message": "Report the active tab title and tab id.",
                        "mode": "agent",
                        "client_id": "native-protocol-e2e",
                    },
                    args.timeout,
                )
                run_id = str(started.get("run_id", ""))
                require(run_id, "agent.start did not return a run id")
                require(
                    state.first_request_received.wait(timeout=args.timeout),
                    "mock model did not receive the first request",
                )
                health_started = time.monotonic()
                try:
                    health = host.request("agent.health", None, args.timeout)
                finally:
                    state.release_first_response.set()
                health_latency = time.monotonic() - health_started
                require(health.get("ok") is True, "agent.health failed during model request")
                require(health_latency < 2.0, "agent.health was blocked by the model request")

                run_state, result, events = host.wait_for_run(run_id, args.timeout)
                require(run_state == "done", "mock protocol run did not complete")
                answer = str(result.get("message", ""))
                require("Protocol Test" in answer and "42" in answer, "final answer lost tool data")
                require(result.get("details_available") is True, "run details were not retained")
                require("debug" not in result, "agent.done still contained inline debug details")
                require("tool_results" not in result, "agent.done still contained inline tool results")
                details = host.request(
                    "agent.run_details",
                    {"run_id": run_id, "client_id": "native-protocol-e2e"},
                    args.timeout,
                )
                require(details.get("run_id") == run_id, "run details returned the wrong run")
                debug = details.get("debug") or {}
                tool_results = debug.get("tool_results") or []
                require(
                    any(result.get("tool_name") == "browser_active_tab" for result in tool_results),
                    "run details lost the extension tool result",
                )
                event_names = [event.get("event") for event in events]
                require("extension.tool.request" in event_names, "extension tool request was not emitted")
                require("agent.tool.started" in event_names, "tool start event was not emitted")
                require("agent.tool.finished" in event_names, "tool finish event was not emitted")
                require("agent.delta" in event_names, "model deltas were not emitted")
                require(len(state.requests) == 2, "mock model did not receive exactly two rounds")
                print(
                    "PASS agent.start extension_tool_roundtrip "
                    f"events={len(events)} details=lazy health_ms={health_latency * 1000:.0f}"
                )
            finally:
                state.release_first_response.set()
                host.close()
                diagnostics = host.diagnostics()
                if diagnostics:
                    print("Native host diagnostics:", file=sys.stderr)
                    print(diagnostics, file=sys.stderr)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run deterministic native protocol E2E tests.")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--release", action="store_true", help="Test the release native binary.")
    parser.add_argument("--skip-build", action="store_true", help="Use an existing native binary.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        run_test(args)
    except subprocess.CalledProcessError as error:
        print(f"Build failed with exit code {error.returncode}", file=sys.stderr)
        return error.returncode
    except Exception as error:
        print(f"Native protocol E2E failed: {error}", file=sys.stderr)
        return 1
    print("Native protocol E2E passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
