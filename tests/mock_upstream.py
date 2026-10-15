#!/usr/bin/env python3
"""Disposable fictional Llama Stack upstream. Standard library only."""
import argparse
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODES = {"default", "http_503", "malformed_json", "malformed_shape",
         "oversize", "usage_invalid", "finish_length", "unicode"}
ROUTES = {"models", "chat"}
MAX_BODY = 131072
MODEL_LIST = [{"identifier": "fixture-model", "provider_id": "fixture-lab"},
              {"id": "second-model"}]
REPLY = {"completion_message": {
    "role": "assistant", "content": "Fixture response", "stop_reason": "end_of_turn"
}, "usage": {"input_tokens": 4, "output_tokens": 7}}


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, Handler)
        self.lock = threading.Lock()
        self.modes = {"models": "default", "chat": "default"}
        self.observations = []


class Handler(BaseHTTPRequestHandler):
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
            # 2024-10-31 legacy contract: top-level model/messages/stream;
            # generation limit, if supplied, belongs in sampling_params.
            if not isinstance(body, dict) or (set(body) -
                    {"model", "messages", "stream", "sampling_params"}):
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
        if mode == "oversize":
            return self.reply(200, b'{"data":"' + b'x' * (1024 * 1024 + 512) + b'"}', raw=True)
        if route == "models":
            return self.reply(200, MODEL_LIST)
        data = json.loads(json.dumps(REPLY))
        if mode == "usage_invalid":
            data["usage"]["input_tokens"] = -2
        if mode == "finish_length":
            data["completion_message"]["stop_reason"] = "out_of_tokens"
        if mode == "unicode":
            data["completion_message"]["content"] = "こんにちは 🌿"
        return self.reply(200, data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
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
