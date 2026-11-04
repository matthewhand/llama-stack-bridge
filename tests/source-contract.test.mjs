import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Dockerfile uses packaged nginx/njs with unprivileged runtime', () => {
    const d = read('nginx/Dockerfile');
    assert.match(d, /^ARG ALPINE_BASE$/m);
    assert.doesNotMatch(d, /^ARG ALPINE_BASE=/m);
    assert.match(d, /^FROM \$\{ALPINE_BASE\}$/m);
    assert.match(d, /nginx-mod-http-js/);
    assert.match(d, /gettext-envsubst/);
    for (const v of ['APK_REPOSITORY', 'NGINX_APK_VERSION',
        'NJS_APK_VERSION', 'GETTEXT_APK_VERSION']) {
        assert.match(d, new RegExp('^ARG ' + v + '$', 'm'));
    }
    assert.match(d, /apk add --no-cache "nginx=\$NGINX_APK_VERSION"/);
    assert.match(d, /https:\/\/\*/);
    assert.match(d, /APK_REPOSITORY" in \*\[!/);
    assert.doesNotMatch(d, /apk add --no-cache nginx /);
    assert.match(d, /^USER nginx$/m);
    assert.doesNotMatch(d, /wget http:|git clone|ubuntu:20\.04/);
    // Parse the shell in the multi-line RUN instruction without executing apk.
    const run = d.split('RUN set -eu;')[1]?.split('\nCOPY ')[0];
    assert.ok(run, 'Missing verified Dockerfile RUN instruction');
    const syntax = spawnSync('sh', ['-n'], {
        input: 'set -eu;' + run, encoding: 'utf8', timeout: 1000
    });
    assert.equal(syntax.status, 0, syntax.stderr);
});
test('Nginx uses bounded njs Fetch API and protected routes', () => {
    const n = read('nginx/nginx.conf');
    assert.match(n, /load_module \/usr\/lib\/nginx\/modules\/ngx_http_js_module\.so;/);
    assert.match(n, /set \$upstream_host "\$UPSTREAM_HOST";/);
    assert.match(n, /set \$upstream_models_url "http:\/\/\$UPSTREAM_IP:\$UPSTREAM_PORT\/models\/list";/);
    assert.match(n, /set \$upstream_chat_url "http:\/\/\$UPSTREAM_IP:\$UPSTREAM_PORT\/inference\/chat_completion";/);
    assert.match(n, /location = \/v1\/models/);
    assert.match(n, /location = \/v1\/chat\/completions/);
    assert.match(n, /js_fetch_max_response_buffer_size 1m;/);
    assert.match(n, /js_fetch_timeout 30s;/);
    assert.match(n, /client_max_body_size 64k;/);
    assert.match(n, /access_log off;/);
    assert.match(n, /limit_conn bridge_clients 8;/);
    assert.match(n, /limit_conn_zone \$server_name zone=bridge_global:1m;/);
    assert.equal((n.match(/limit_conn bridge_global 4;/g) || []).length, 4);
    assert.doesNotMatch(n, /proxy_pass|proxy_buffer|proxy_max_temp_file_size|subrequest_output_buffer_size|\binternal;/);
});
test('legacy upstream API and immutable package provenance are pinned', () => {
    const p = read('tests/VERIFICATION.md');
    assert.match(p, /37b330b4ef24a9253abba07cf906bf4ac3af6e55/);
    assert.match(p, /llama-stack==0\.0\.47/);
    assert.match(p, /llama-models==0\.0\.47/);
    assert.match(p, /1f7f10945736b21d42a24d6be1b425e5b6d3deb41395173fa350c04f2c674794/);
    assert.match(p, /42775cf72c4915f2fbad148097757ceb4dc43ac5d27e31d286aa8ebf083bb1bc/);
    assert.match(p, /GET \/models\/list/);
    assert.match(p, /POST \/inference\/chat_completion/);
    assert.match(p, /tool_calls/);
    assert.match(p, /No live Llama Stack server/);
});

test('njs 0.9.6 chunked-response ceiling is bounded by global concurrency', () => {
    const n = read('nginx/nginx.conf');
    const d = read('docker-compose.yaml');
    const m = read('tests/mock_upstream.py');
    const v = read('tests/verify_http.py');
    assert.match(n, /chunked parser can/);
    assert.match(n, /buffer up to 10 MiB/);
    assert.match(n, /approximately 40 MiB/);
    assert.equal((n.match(/limit_conn bridge_global 4;/g) || []).length, 4);
    assert.match(d, /mem_limit: 256m/);
    assert.match(m, /oversize_chunked_hard_cap/);
    assert.match(m, /exact_limit_chunked/);
    assert.match(v, /exact_limit_chunked/);
    assert.match(v, /oversize_chunked_hard_cap/);
    assert.doesNotMatch(v, /0\.0\.53|model_id/);
});

test('Compose stays loopback-bound and drops capabilities', () => {
    const c = read('docker-compose.yaml');
    assert.match(c, /127\.0\.0\.1:42070:8080/);
    assert.match(c, /read_only: true/);
    assert.match(c, /no-new-privileges:true/);
    assert.match(c, /cap_drop:/);
    assert.match(c, /pids_limit: 64/);
    assert.match(c, /ALPINE_IMAGE_DIGEST:\?/);
    assert.match(c, /NGINX_APK_VERSION:\?/);
    assert.match(c, /NJS_APK_VERSION:\?/);
    assert.match(c, /GETTEXT_APK_VERSION:\?/);
    assert.doesNotMatch(c, /"\s*42070:80"/);
});
test('startup validates and resolves upstream before interpolation', () => {
    const s = read('nginx/entrypoint.sh');
    assert.match(s, /getent ahostsv4/);
    assert.match(s, /valid_ipv4/);
    assert.match(s, /export UPSTREAM_IP/);
    assert.match(s, /envsubst '\$UPSTREAM_HOST \$UPSTREAM_IP \$UPSTREAM_PORT'/);
    assert.match(s, /nginx -e stderr -t -c \/tmp\/llama-stack-bridge\.conf/);
    assert.match(s, /exec nginx -e stderr/);
    assert.match(s, /Invalid UPSTREAM_HOST/);
    assert.match(s, /Invalid UPSTREAM_PORT/);
    assert.match(s, /entrypoint_mode=\$\{1:-\}/);
    assert.match(s, /if \[ "\$entrypoint_mode" = "--check" \]; then/);
    assert.doesNotMatch(s, /\beval\b/);
});
test('packaged njs parser rejects for-of loops, use compatible indexed iteration', () => {
    const source = read('nginx/transform.js');
    assert.doesNotMatch(source, /\bfor\s*\(\s*(?:(?:var|let|const)\s+)?[A-Za-z_$][\w$]*\s+of\b/);
    assert.match(source, /for \(var messageIndex = 0;/);
});

test('njs Fetch API caps raw response bytes and never logs request/response data', () => {
    const s = read('nginx/transform.js');
    assert.doesNotMatch(s, /\br\.error\(/);
    assert.doesNotMatch(s, /\br\.log\(/);
    assert.equal((s.match(/max_response_body_size: MAX_UPSTREAM_BYTES/g) || []).length, 2);
    assert.equal((s.match(/await reply\.text\(\)/g) || []).length, 2);
    assert.equal((s.match(/Buffer\.byteLength\(responseText, 'utf8'\) > MAX_UPSTREAM_BYTES/g) || []).length, 2);
    assert.match(s, /var upstream = \{ model: input\.model, messages: messages, stream: false \}/);
    assert.match(s, /upstream\.sampling_params = \{ max_tokens: input\.max_tokens \}/);
    assert.doesNotMatch(s, /model_id|strategy: 'greedy'/);
    assert.match(s, /forwarded\.tool_calls = \[\]/);
    assert.match(s, /raw\.completion_message\.tool_calls !== undefined/);
    assert.doesNotMatch(s, /r\.subrequest|responseBuffer|boundedReplyText/);
    assert.match(s, /new Uint32Array\(4\)/);
    assert.doesNotMatch(s, /new Uint8Array\(16\)/);
});

// Validate the actual pre-interpolation shell code with fake environment values.
// No Nginx, Docker, real network or filesystem modifications are involved.
test('entrypoint validates DNS/IP and fails closed on resolution errors', () => {
    const entry = read('nginx/entrypoint.sh');
    const validation = entry.split('# Only substitute our three validated values;')[0];
    const stub = `getent() {
        [ "$1" = "ahostsv4" ] || return 2
        [ "$2" != "unresolved.local" ] || return 2
        echo "127.0.0.1 STREAM $2"
    }
`;
    const preflight = stub + validation + `
test "$UPSTREAM_IP" = "127.0.0.1"
exit 0
`;
    const accepted = ['mock', 'api.local', 'my-server', 'a.b-c.example',
        '127.0.0.1', '0.0.0.0', '255.255.255.255',
        'a'.repeat(63) + '.example'];
    const rejected = ['', 'bad..name', '.bad', 'bad.', '-bad', 'bad-',
        'a.-bad', 'bad-.local', 'a'.repeat(64)+'.local', '999.1.2.3',
        '256.1.2.3', '192.168.01.1', '1.2.3', '1.2.3.4.5',
        'host;echo', 'host/route', 'http://upstream', 'foo\\nbar',
        '::1', '1234'];
    function check(host, port = '8765') {
        const run = spawnSync('sh', ['-c', preflight], {
            env: { UPSTREAM_HOST: host, UPSTREAM_PORT: port },
            encoding: 'utf8', timeout: 1000
        });
        assert.equal(run.error, undefined);
        return run.status;
    }
    for (const host of accepted) assert.equal(check(host), 0, host);
    for (const host of rejected) assert.notEqual(check(host), 0, host);
    for (const port of ['', '0', '-1', '65536', 'abc', '80;bad']) {
        assert.notEqual(check('mock', port), 0, port);
    }
    assert.equal(check('mock','65535'), 0);
    assert.notEqual(check('unresolved.local'), 0, 'unresolvable DNS must fail closed');
    const retainedMode = spawnSync('sh', ['-c',
        stub + validation + `
test "$entrypoint_mode" = "--check"
`, '--', '--check'], {
        env: {UPSTREAM_HOST:'mock', UPSTREAM_PORT:'8765'},
        encoding:'utf8', timeout:1000
    });
    assert.equal(retainedMode.status, 0, retainedMode.stderr);
});

test('runtime verification requires isolated immutable/snapshot build inputs', () => {
    const c = read('tests/runtime.compose.yaml');
    for (const key of ['ALPINE_IMAGE_DIGEST', 'APK_REPOSITORY',
        'NGINX_APK_VERSION', 'NJS_APK_VERSION', 'GETTEXT_APK_VERSION']) {
        assert.match(c, new RegExp('\\$\\{' + key + ':\\?'));
    }
    assert.match(c, /internal: true/);
    assert.match(c, /127\.0\.0\.1:42070:8080/);
});
