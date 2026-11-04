#!/usr/bin/env python3
"""Disposable fictional Llama Stack upstream. Standard library only."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODES = {"default", "http_503", "malformed_json", "malformed_shape",
         "oversize", "oversize_chunked", "oversize_unicode", "oversize_chunked_hard_cap", "exact_limit", "exact_limit_chunked",
         "finish_length", "unicode",
         "finish_unknown", "finish_missing", "slow", "slow_short"}
ROUTES = {"models", "chat"}
MAX_BODY = 131072
MODEL_LIST = [{"identifier": "fixture-model", "provider_id": "fixture-lab"},
              {"id": "second-model"}]
REPLY = {"completion_message": {
    "role": "assistant", "content": "Fixture response", "stop_reason": "end_of_turn",
    "tool_calls": []
}}


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, Handler)
        self.lock = threading.Lock()
        self.modes = {"models": "default", "chat": "default"}
        self.observations = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SyntheticFixture"
    sys_version = ""

    def log_message(self, *args):
        # Never log bodies or query strings, even for synthetic fixtures.
        return

    def reply(self, status, value, raw=False):
        data = value if raw else json.dumps(value, ensure_ascii=False).encode("utf-8")
        if isinstance(data, str):
            data = data.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def reply_chunked(self, status, chunks):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            for chunk in chunks:
                self.wfile.write(("%X\r\n" % len(chunk)).encode("ascii"))
                self.wfile.write(chunk + b"\r\n")
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass

    def body(self):
        length = self.headers.get("Content-Length")
        if length is None or not length.isdecimal() or int(length) > MAX_BODY:
            raise ValueError("Invalid request size")
        data = self.rfile.read(int(length))
        if len(data) != int(length):
            raise ValueError("Truncated request")
        return json.loads(data)

    def do_GET(self):
        if self.path == "/__admin/observations":
            with self.server.lock:
                observations = list(self.server.observations)
            return self.reply(200, {"observations": observations})
        if self.path == "/__admin/state":
            with self.server.lock:
                state = dict(self.server.modes)
            return self.reply(200, {"modes": state})
        if self.path != "/models/list":
            return self.reply(404, {"error": "fixture route not found"})
        return self.handle_upstream("models", None)

    def do_POST(self):
        if self.path == "/__admin/reset":
            with self.server.lock:
                self.server.observations.clear()
                self.server.modes = {"models": "default", "chat": "default"}
            return self.reply(200, {"ok": True})
        if self.path == "/__admin/scenario":
            try:
                body = self.body()
                if not isinstance(body, dict) or set(body) != {"route", "mode"}:
                    raise ValueError("Invalid scenario")
                route, mode = body["route"], body["mode"]
                if route not in ROUTES or mode not in MODES:
                    raise ValueError("Unknown scenario")
            except (ValueError, TypeError, KeyError):
                return self.reply(400, {"error": "invalid scenario"})
            with self.server.lock:
                self.server.modes[route] = mode
            return self.reply(200, {"ok": True})
        if self.path != "/inference/chat_completion":
            return self.reply(404, {"error": "fixture route not found"})
        try:
            body = self.body()
        except (ValueError, TypeError):
            return self.reply(400, {"error": "invalid fixture body"})
        return self.handle_upstream("chat", body)

    def handle_upstream(self, route, body):
        if route == "chat":
            # llama-stack 0.0.47 / 2024-10-31 source contract: model/messages,
            # optional SamplingParams (greedy by default), and text-only messages.
            allowed = {"model", "messages", "sampling_params", "stream"}
            if not isinstance(body, dict) or set(body) - allowed:
                return self.reply(422, {"error": "invalid legacy fixture shape"})
            if not isinstance(body.get("model"), str) or not isinstance(
                    body.get("messages"), list) or body.get("stream", False) is not False:
                return self.reply(422, {"error": "invalid legacy fixture fields"})
            params = body.get("sampling_params", {})
            if not isinstance(params, dict) or set(params) - {"max_tokens"}:
                return self.reply(422, {"error": "invalid legacy sampling params"})
            if "max_tokens" in params and (type(params["max_tokens"]) is not int or
                    params["max_tokens"] < 1):
                return self.reply(422, {"error": "invalid token bound"})
            for message in body["messages"]:
                if not isinstance(message, dict) or message.get("role") not in (
                        "system", "user", "assistant") or not isinstance(
                        message.get("content"), str):
                    return self.reply(422, {"error": "invalid legacy message"})
                if message["role"] == "assistant":
                    if set(message) != {"role", "content", "stop_reason", "tool_calls"} or \
                            not isinstance(message["stop_reason"], str) or message["tool_calls"] != []:
                        return self.reply(422, {"error": "invalid legacy assistant history"})
                elif set(message) != {"role", "content"}:
                    return self.reply(422, {"error": "invalid legacy user/system message"})
        with self.server.lock:
            mode = self.server.modes[route]
            self.server.observations.append({
                "route": route,
                "method": self.command,
                "path": self.path,
                "headers": {k.lower(): v for k, v in self.headers.items()},
                "body": body,
            })
        if mode == "http_503":
            return self.reply(503, {"error": "PRIVATE_UPSTREAM_CANARY"})
        if mode == "malformed_json":
            return self.reply(200, b'{"unclosed":', raw=True)
        if mode == "malformed_shape":
            return self.reply(200, {"unexpected": "private"})
        if mode in ("exact_limit", "exact_limit_chunked"):
            prefix = b'[]'
            data = prefix + b' ' * (1024 * 1024 - len(prefix))
            if mode == "exact_limit_chunked":
                return self.reply_chunked(200, (data[i:i + 16384]
                                                for i in range(0, len(data), 16384)))
            return self.reply(200, data, raw=True)
        if mode in ("oversize", "oversize_chunked"):
            data = b'{"data":"PRIVATE_UPSTREAM_CANARY' + b'x' * (1024 * 1024 + 512) + b'"}'
            if mode == "oversize_chunked":
                return self.reply_chunked(200, (data[i:i + 16384]
                                                for i in range(0, len(data), 16384)))
            return self.reply(200, data, raw=True)
        if mode == "oversize_unicode":
            data = json.dumps([{"identifier": "PRIVATE_UPSTREAM_CANARY" + "あ" * 350000}],
                              ensure_ascii=False).encode("utf-8")
            return self.reply(200, data, raw=True)
        if mode == "oversize_chunked_hard_cap":
            data = b'{"data":"PRIVATE_UPSTREAM_CANARY' + b'x' * (10 * 1024 * 1024 + 512) + b'"}'
            return self.reply_chunked(200, (data[i:i + 16384]
                                            for i in range(0, len(data), 16384)))
        if mode == "slow_short":
            # Hold a small number of requests concurrently to exercise global limits.
            import time
            time.sleep(3)
        if mode == "slow":
            # Deliberate 35s idle upstream for separately approved runtime tests.
            import time
            time.sleep(35)
        if route == "models":
            return self.reply(200, MODEL_LIST)
        data = json.loads(json.dumps(REPLY))
        if mode == "finish_length":
            data["completion_message"]["stop_reason"] = "out_of_tokens"
        if mode == "unicode":
            data["completion_message"]["content"] = "こんにちは 🌿"
        if mode == "finish_unknown":
            data["completion_message"]["stop_reason"] = "future_finish"
        if mode == "finish_missing":
            del data["completion_message"]["stop_reason"]
        return self.reply(200, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    # Direct local use must not expose fixture admin endpoints to the network.
    # The disposable runtime Compose explicitly overrides this to bind its
    # isolated container interface for bridge-to-mock verification.
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    server = FixtureServer((args.host, args.port))
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
