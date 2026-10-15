"""Offline synthetic checks: mock server, bad-response oracle, optimized Python."""
import ast
import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import threading
import unittest

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

    def test_model_fixture_and_observations(self):
        obj = json.loads(verify.request(self.base, "/models/list")[1])
        self.assertEqual(obj, mock.MODEL_LIST)
        observed = verify.observations(self.base)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]["method"], "GET")

    def test_chat_fixture_and_exact_body(self):
        payload = {"model": "fixture-model", "messages": [{"role": "user",
                   "content": "Fictional request"}]}
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

    def test_wrong_upstream_payload_fails_closed(self):
        payload = {"model": "actual", "messages": []}
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
