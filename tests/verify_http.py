#!/usr/bin/env python3
"""Fail-closed real-HTTP acceptance checks against an approved disposable bridge."""
import argparse
import ipaddress
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

TOKEN = "SYNTHETIC_AUTH_CANARY_DO_NOT_FORWARD"
COOKIE = "SYNTHETIC_COOKIE_CANARY_DO_NOT_FORWARD"
CUSTOM = "SYNTHETIC_CUSTOM_CANARY_DO_NOT_FORWARD"
PRIVATE = "PRIVATE_UPSTREAM_CANARY"
MAX_RESPONSE = 2 * 1024 * 1024
TIMEOUT = 8


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def loopback_url(url):
    parsed = urllib.parse.urlsplit(url)
    try:
        host_ok = ipaddress.ip_address(parsed.hostname).is_loopback
    except (ValueError, TypeError):
        host_ok = False
    require(parsed.scheme == "http" and host_ok and parsed.port is not None
            and not parsed.username and not parsed.password
            and not parsed.path.strip("/") and not parsed.query and not parsed.fragment,
            "Only explicit numeric loopback HTTP URLs with ports are allowed")
    return url.rstrip("/")


def request(base, path, method="GET", payload=None, raw=False, privacy=False):
    require(path.startswith("/") and not path.startswith("//"), "Invalid test route")
    headers = {"Accept": "application/json"}
    data = None
    if payload is not None:
        data = payload if raw else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if privacy:
        headers.update({"Authorization": "Bearer " + TOKEN, "Cookie": COOKIE,
                        "X-Private-Canary": CUSTOM, "X-Test-Secret": CUSTOM})
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, res.read(MAX_RESPONSE + 1), res.headers.get("Content-Type", "")
    except urllib.error.HTTPError as res:
        return res.code, res.read(MAX_RESPONSE + 1), res.headers.get("Content-Type", "")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise VerificationError("HTTP transport failed (not proof of upstream timeout): " +
                                type(e).__name__) from e


def response_json(response, status, error_type=None):
    actual, body, ctype = response
    require(actual == status, "Wrong HTTP status: expected %s, received %s" %
            (status, actual))
    require(len(body) <= MAX_RESPONSE, "Client response exceeded verification bound")
    require("application/json" in ctype.lower(), "Expected JSON Content-Type")
    try:
        obj = json.loads(body)
    except (UnicodeError, ValueError) as e:
        raise VerificationError("Invalid JSON in bridge response") from e
    require(isinstance(obj, dict), "Expected a JSON object")
    require(not any(secret in body.decode("utf-8", errors="replace")
                    for secret in (TOKEN, COOKIE, CUSTOM, PRIVATE)),
            "Private synthetic canary leaked to client")
    if error_type is not None:
        err = obj.get("error")
        require(isinstance(err, dict) and err.get("type") == error_type,
                "Wrong structured error category")
    return obj


def observations(mock):
    obj = response_json(request(mock, "/__admin/observations"), 200)
    calls = obj.get("observations")
    require(isinstance(calls, list), "Missing mock observations")
    return calls


def reset(mock, route=None, mode="default"):
    response_json(request(mock, "/__admin/reset", method="POST"), 200)
    if route is not None:
        response_json(request(mock, "/__admin/scenario", method="POST",
                              payload={"route": route, "mode": mode}), 200)


def check_calls(mock, expected_route, expected_count, expected_body=None):
    calls = observations(mock)
    require(len(calls) == expected_count,
            "Wrong number of actual upstream calls: expected %s, received %s" %
            (expected_count, len(calls)))
    expected_path = ("/models/list" if expected_route == "models"
                     else "/inference/chat_completion")
    for call in calls:
        require(call.get("route") == expected_route and call.get("path") == expected_path,
                "Upstream route translation did not match the fixture")
        require(call.get("method") == ("GET" if expected_route == "models" else "POST"),
                "Wrong upstream HTTP method")
        headers = call.get("headers", {})
        require(isinstance(headers, dict), "Mock headers missing")
        require(not any(h in headers for h in ("authorization", "proxy-authorization",
                                              "cookie", "x-private-canary", "x-test-secret")),
                "Sensitive client headers were forwarded")
        require(not any(secret in str(v) for v in headers.values()
                        for secret in (TOKEN, COOKIE, CUSTOM)),
                "Synthetic credentials were forwarded in a header value")
        require(headers.get("host") == "mock",
                "Upstream Host header is not the configured mock host")
        if expected_body is not None:
            require(call.get("body") == expected_body,
                    "Translated upstream JSON payload does not match exact expected object")
    return calls


def run_suite(bridge, mock):
    completed = []

    def case(name, fn):
        fn()
        completed.append(name)
        print("PASS " + name, flush=True)

    def model_ok(path):
        reset(mock)
        result = response_json(request(bridge, path, privacy=True), 200)
        require(result == {"object": "list", "data": [
            {"id": "fixture-model", "object": "model", "owned_by": "fixture-lab"},
            {"id": "second-model", "object": "model", "owned_by": "llama-stack"}]},
            "Model-list translation is not exact")
        check_calls(mock, "models", 1)

    case("models endpoint and privacy", lambda: model_ok("/v1/models"))
    case("models alias and privacy", lambda: model_ok("/models"))

    valid = {"model": "fixture-model", "messages": [
        {"role": "system", "content": "Fictional setup"},
        {"role": "assistant", "content": "Fictional history"},
        {"role": "user", "content": "さくら 🌿"}],
        "max_tokens": 8}
    translated = {"model": "fixture-model", "messages": [
        {"role": "system", "content": "Fictional setup"},
        {"role": "assistant", "content": "Fictional history", "stop_reason": "end_of_turn"},
        {"role": "user", "content": "さくら 🌿"}],
        "stream": False, "sampling_params": {"max_tokens": 8}}

    def chat_ok(path):
        reset(mock)
        obj = response_json(request(bridge, path, method="POST",
                                    payload=valid, privacy=True), 200)
        require(obj.get("object") == "chat.completion" and
                obj.get("model") == "fixture-model", "Wrong completion envelope")
        require(obj.get("choices") == [{"index": 0, "message": {
            "role": "assistant", "content": "Fixture response"}, "finish_reason": "stop"}],
            "Wrong completion choice transformation")
        require(obj.get("usage") == {"prompt_tokens": 4, "completion_tokens": 7,
                                     "total_tokens": 11}, "Wrong token usage transformation")
        require(isinstance(obj.get("id"), str) and obj["id"].startswith("chatcmpl-"),
                "Missing completion id")
        check_calls(mock, "chat", 1, translated)

    case("chat endpoint exact payload and privacy", lambda: chat_ok("/v1/chat/completions"))
    case("chat alias exact payload and privacy", lambda: chat_ok("/chat/completions"))

    def invalid_case(name, path, method, payload, status, category, raw=False):
        def check():
            reset(mock)
            result = response_json(request(bridge, path, method=method,
                                           payload=payload, raw=raw, privacy=True),
                                   status, category)
            require("error" in result, "Missing JSON error")
            require(len(observations(mock)) == 0, "Rejected request hit upstream")
        case(name, check)

    invalid_case("stream rejected", "/v1/chat/completions", "POST",
                 dict(valid, stream=True), 501, "not_implemented")
    invalid_case("tools rejected", "/v1/chat/completions", "POST",
                 dict(valid, tools=[]), 400, "unsupported_parameter")
    invalid_case("multimodal rejected", "/v1/chat/completions", "POST",
                 {"model": "fixture-model", "messages": [
                     {"role": "user", "content": [{"type": "image", "url": "fixture"}]}]},
                 400, "invalid_request_error")
    invalid_case("unsupported temperature rejected", "/v1/chat/completions", "POST",
                 dict(valid, temperature=0), 400, "unsupported_parameter")
    invalid_case("unsupported top_p rejected", "/v1/chat/completions", "POST",
                 dict(valid, top_p=0.5), 400, "unsupported_parameter")
    invalid_case("unsupported top_k rejected", "/v1/chat/completions", "POST",
                 dict(valid, top_k=1), 400, "unsupported_parameter")
    invalid_case("unsupported repeat_penalty rejected", "/v1/chat/completions", "POST",
                 dict(valid, repeat_penalty=1.2), 400, "unsupported_parameter")
    invalid_case("invalid max_tokens rejected", "/v1/chat/completions", "POST",
                 dict(valid, max_tokens=0), 400, "invalid_request_error")
    invalid_case("malformed client JSON rejected", "/v1/chat/completions", "POST",
                 b'{"unclosed":', 400, "invalid_request_error", raw=True)
    invalid_case("missing model rejected", "/v1/chat/completions", "POST",
                 {"messages": valid["messages"]}, 400, "invalid_request_error")
    invalid_case("model POST method rejected", "/v1/models", "POST",
                 {}, 405, "method_not_allowed")
    invalid_case("chat GET method rejected", "/v1/chat/completions", "GET",
                 None, 405, "method_not_allowed")

    for route, path, method, payload in (
        ("models", "/v1/models", "GET", None),
        ("chat", "/v1/chat/completions", "POST", valid),
    ):
        for mode, error in (("http_503", "upstream_error"),
                            ("malformed_json", "invalid_upstream_response"),
                            ("malformed_shape", "invalid_upstream_response")):
            def bad_upstream(route=route, path=path, method=method,
                             payload=payload, mode=mode, error=error):
                reset(mock, route, mode)
                response_json(request(bridge, path, method=method,
                                      payload=payload, privacy=True), 502, error)
                check_calls(mock, route, 1,
                            translated if route == "chat" else None)
            case(route + " " + mode + " error category and privacy", bad_upstream)

    for mode, expected_content, reason, has_usage in (
        ("unicode", "こんにちは 🌿", "stop", True),
        ("finish_length", "Fixture response", "length", True),
        ("usage_invalid", "Fixture response", "stop", False),
    ):
        def special(mode=mode, expected_content=expected_content,
                    reason=reason, has_usage=has_usage):
            reset(mock, "chat", mode)
            obj = response_json(request(bridge, "/v1/chat/completions", method="POST",
                                        payload=valid), 200)
            require(obj["choices"][0]["message"]["content"] == expected_content,
                    "Wrong Unicode/response content")
            require(obj["choices"][0]["finish_reason"] == reason,
                    "Wrong finish reason")
            require(("usage" in obj) == has_usage, "Invalid usage normalization")
            check_calls(mock, "chat", 1, translated)
        case("chat " + mode + " response handling", special)

    def large_request():
        reset(mock)
        large = {"model": "fixture-model", "messages": [
            {"role": "user", "content": "A" * 70000}]}
        status, data, ctype = request(bridge, "/v1/chat/completions",
                                       method="POST", payload=large)
        require(status == 413, "Expected Nginx 413 for over-limit client body")
        require("application/json" not in ctype.lower(),
                "Expected Nginx-generated, not njs-generated, size rejection")
        require(not observations(mock), "Oversized request reached upstream")
        require(not any(s.encode() in data for s in (TOKEN, COOKIE, CUSTOM, PRIVATE)),
                "Private canary leaked in Nginx-generated error")
    case("Nginx-generated client body size boundary", large_request)

    def large_upstream():
        reset(mock, "models", "oversize")
        status, body, ctype = request(bridge, "/v1/models", privacy=True)
        require(status in (500, 502),
                "Oversized upstream reply incorrectly accepted or ignored")
        require(not any(s.encode() in body for s in (TOKEN, COOKIE, CUSTOM, PRIVATE)),
                "Private canary leaked in oversized upstream error")
        if "application/json" in ctype.lower():
            require(status == 502, "Unexpected JSON upstream size error status")
            response_json((status, body, ctype), 502, "upstream_error")
        else:
            require(status == 500, "Unexpected Nginx-generated size error")
        check_calls(mock, "models", 1)
    case("oversized upstream buffer failure category", large_upstream)

    def health():
        reset(mock)
        status, data, _ = request(bridge, "/healthz")
        require(status == 200 and data == b"ok\n", "Wrong healthz result")
        require(not observations(mock), "Health check reached mock upstream")
    case("healthz independence", health)
    return completed


def self_test(negative=False):
    checks = [
        lambda: response_json((200, b'{"error":{"type":"wrong"}}',
                               "application/json"), 502, "upstream_error"),
        lambda: response_json((502, b'{"error":{"type":"wrong"}}',
                               "application/json"), 502, "upstream_error"),
        lambda: response_json((502, b'not json', "application/json"),
                              502, "upstream_error"),
        lambda: require({"model": "wrong"} == {"model": "expected"},
                        "wrong payload accepted"),
        lambda: require(False, "wrong header forwarding accepted"),
    ]
    if negative:
        checks[0]()  # Must exit nonzero in both ordinary and optimized execution.
        raise VerificationError("Negative-control mismatch was incorrectly accepted")
    detected = 0
    for check in checks:
        try:
            check()
        except VerificationError:
            detected += 1
    require(detected == len(checks), "Fail-closed controls did not catch every defect")
    print("PASS %d/%d intentional false-PASS controls rejected" %
          (detected, len(checks)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge", default="http://127.0.0.1:42070")
    parser.add_argument("--mock", default="http://127.0.0.1:42071")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--negative-control", action="store_true")
    parser.add_argument("--scan-only", action="store_true")
    parser.add_argument("--evidence", type=pathlib.Path)
    parser.add_argument("--log-file", action="append", type=pathlib.Path, default=[])
    args = parser.parse_args()
    try:
        if args.self_test or args.negative_control:
            self_test(negative=args.negative_control)
            return 0
        require(not args.scan_only or bool(args.log_file),
                "--scan-only requires at least one explicitly supplied log file")
        if args.scan_only:
            passed = []
        else:
            bridge, mock = loopback_url(args.bridge), loopback_url(args.mock)
            passed = run_suite(bridge, mock)
        for path in args.log_file:
            content = path.read_text(encoding="utf-8", errors="replace")
            require(not any(s in content for s in (TOKEN, COOKIE, CUSTOM, PRIVATE,
                                                   "さくら 🌿", "Fictional history")),
                    "Test-owned log contains synthetic private canary")
        if args.evidence and not args.scan_only:
            manifest = {"result": "PASS", "checks": passed, "passed": len(passed),
                        "failed": 0, "log_files_scanned": len(args.log_file),
                        "scope": "disposable synthetic HTTP; NOT live Llama Stack"}
            args.evidence.write_text(json.dumps(manifest, indent=2) + "\n",
                                     encoding="utf-8")
        print("PASS %d HTTP checks; %d supplied log files scanned" %
              (len(passed), len(args.log_file)))
        return 0
    except (VerificationError, OSError, ValueError, KeyError, TypeError) as e:
        # Deliberately do not include any response body or request fixture.
        print("FAIL " + str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
