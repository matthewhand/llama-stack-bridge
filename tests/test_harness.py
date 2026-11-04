"""Offline synthetic checks: mock server, bad-response oracle, optimized Python."""
import ast
import json
import importlib.util
import os
from unittest import mock as unittest_mock
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent


def load_module(filename, name):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mock = load_module("mock_upstream.py", "fixture_mock")
verify = load_module("verify_http.py", "fixture_verifier")


class MockFixtureChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = mock.FixtureServer(("127.0.0.1", 0))
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.worker.join(timeout=3)
        cls.server.server_close()

    def setUp(self):
        verify.reset(self.base)

    def test_mock_cli_defaults_loopback_and_disposable_runtime_binds_explicitly(self):
        fixture = (HERE / "mock_upstream.py").read_text()
        runtime = (HERE / "runtime.compose.yaml").read_text()
        self.assertIn('parser.add_argument("--host", default="127.0.0.1")', fixture)
        self.assertIn('"--host", "0.0.0.0"', runtime)
        self.assertIn('127.0.0.1:42071:8765', runtime)
        self.assertIn('internal: true', runtime)

    def test_model_fixture_and_observations(self):
        obj = json.loads(verify.request(self.base, "/models/list")[1])
        self.assertEqual(obj, mock.MODEL_LIST)
        observed = verify.observations(self.base)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]["method"], "GET")

    def test_chat_fixture_and_exact_body(self):
        payload = {"model": "fixture-model", "messages": [{"role": "user",
                   "content": "Fictional request"}], "sampling_params": {"max_tokens": 8},
                   "stream": False}
        obj = verify.response_json(verify.request(
            self.base, "/inference/chat_completion", method="POST", payload=payload), 200)
        self.assertEqual(obj, mock.REPLY)
        self.assertEqual(verify.observations(self.base)[0]["body"], payload)

    def test_failure_modes_and_fixture_admin(self):
        for mode, status in (("http_503", 503), ("malformed_json", 200),
                             ("malformed_shape", 200)):
            with self.subTest(mode=mode):
                verify.reset(self.base, "models", mode)
                code, body, _ = verify.request(self.base, "/models/list")
                self.assertEqual(code, status)
                self.assertTrue(body)
        code, _, _ = verify.request(self.base, "/__admin/scenario", method="POST",
                                   payload={"route": "models", "mode": "unknown"})
        self.assertEqual(code, 400)

    def test_unknown_stop_reason_fixture_modes(self):
        for mode in ("finish_unknown", "finish_missing"):
            with self.subTest(mode=mode):
                verify.reset(self.base, "chat", mode)
                code, body, _ = verify.request(self.base,
                    "/inference/chat_completion", method="POST", payload={
                        "model": "fixture-model",
                        "messages": [{"role": "user", "content": "Fictional"}],
                        "sampling_params": {}, "stream": False})
                self.assertEqual(code, 200)
                completion = json.loads(body)["completion_message"]
                if mode == "finish_unknown":
                    self.assertEqual(completion["stop_reason"], "future_finish")
                else:
                    self.assertNotIn("stop_reason", completion)

    def test_verifier_http_client_rejects_outbound_redirect_and_environment_proxy(self):
        # Import under a synthetic proxy setting, catching regressions that
        # accidentally enable urllib's default environment ProxyHandler.
        with unittest_mock.patch.dict(os.environ,
                                      {"http_proxy": "http://127.0.0.1:9",
                                       "no_proxy": ""}):
            fresh = load_module("verify_http.py", "verifier_proxy_boundary")
        proxy_handlers = [h for h in fresh.HTTP_OPENER.handlers
                          if isinstance(h, urllib.request.ProxyHandler)]
        self.assertEqual(proxy_handlers, [], "Environment proxy handler is active")

        with self.assertRaises(verify.VerificationError):
            verify.request("http://example.invalid:80", "/no-network")
        with self.assertRaises(verify.VerificationError):
            verify.request("http://localhost:12345", "/no-network")

        destination = self.base + "/models/list"
        class RedirectFixture(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", destination)
                self.end_headers()

        redirector = ThreadingHTTPServer(("127.0.0.1", 0), RedirectFixture)
        worker = threading.Thread(target=redirector.serve_forever, daemon=True)
        worker.start()
        try:
            redirect_base = "http://127.0.0.1:" + str(redirector.server_port)
            with self.assertRaisesRegex(verify.VerificationError, "Unexpected redirect"):
                verify.request(redirect_base, "/redirect", privacy=True)
            self.assertEqual(verify.observations(self.base), [],
                             "Redirected HTTP request reached the destination")
        finally:
            redirector.shutdown()
            worker.join(timeout=3)
            redirector.server_close()

    def test_wrong_upstream_payload_fails_closed(self):
        payload = {"model": "actual", "messages": [{"role": "user", "content": "Fictional"}],
                   "stream": False}
        verify.request(self.base, "/inference/chat_completion",
                       method="POST", payload=payload)
        with self.assertRaises(verify.VerificationError):
            verify.check_calls(self.base, "chat", 1,
                               expected_body={"model": "expected"})

    def test_leaked_header_detected(self):
        verify.request(self.base, "/models/list", privacy=True)
        with self.assertRaises(verify.VerificationError):
            verify.check_calls(self.base, "models", 1)

    def test_log_scan_detects_canary_under_optimization(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.log"
            path.write_text(verify.TOKEN)
            for optimized in (False, True):
                prefix = [sys.executable] + (["-O"] if optimized else [])
                cmd = prefix + [str(HERE / "verify_http.py"), "--scan-only",
                                "--log-file", str(path)]
                bad = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
                self.assertEqual(bad.returncode, 1)
                self.assertNotIn(verify.TOKEN, bad.stderr)
            path.write_text("ordinary service startup, no private fixture")
            good = subprocess.run([sys.executable, str(HERE / "verify_http.py"),
                                   "--scan-only", "--log-file", str(path)],
                                  capture_output=True, text=True, timeout=15)
            self.assertEqual(good.returncode, 0, good.stderr)

    def test_no_optimizable_asserts_in_verifier_or_mock(self):
        for filename in ("verify_http.py", "mock_upstream.py"):
            with self.subTest(filename=filename):
                tree = ast.parse((HERE / filename).read_text())
                self.assertFalse(any(isinstance(x, ast.Assert) for x in ast.walk(tree)))

    def test_negative_controls_fail_in_normal_and_optimized_modes(self):
        for optimized in (False, True):
            prefix = [sys.executable] + (["-O"] if optimized else [])
            with self.subTest(optimized=optimized):
                good = subprocess.run(prefix + [str(HERE / "verify_http.py"),
                                                "--self-test"], capture_output=True,
                                      text=True, timeout=15)
                bad = subprocess.run(prefix + [str(HERE / "verify_http.py"),
                                               "--negative-control"], capture_output=True,
                                     text=True, timeout=15)
                self.assertEqual(good.returncode, 0, good.stderr)
                self.assertEqual(bad.returncode, 1,
                                 "Intentionally wrong output was falsely accepted")


if __name__ == "__main__":
    unittest.main()
