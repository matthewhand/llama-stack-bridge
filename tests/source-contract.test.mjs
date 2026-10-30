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
test('Nginx config has explicit upstream substitution and protected routes', () => {
    const n = read('nginx/nginx.conf');
    assert.match(n, /load_module \/usr\/lib\/nginx\/modules\/ngx_http_js_module\.so;/);
    assert.match(n, /http:\/\/\$UPSTREAM_HOST:\$UPSTREAM_PORT\/models\/list/);
    assert.match(n, /http:\/\/\$UPSTREAM_HOST:\$UPSTREAM_PORT\/inference\/chat_completion/);
    assert.equal((n.match(/^\s*internal;/gm) || []).length, 2);
    assert.match(n, /location = \/v1\/models/);
    assert.match(n, /location = \/v1\/chat\/completions/);
    assert.match(n, /proxy_pass_request_headers off;/);
    assert.match(n, /access_log off;/);
    assert.match(n, /subrequest_output_buffer_size 1m;/);
    assert.match(n, /proxy_max_temp_file_size 0;/);
    assert.match(n, /proxy_buffers 4 16k;/);
    assert.match(n, /limit_conn bridge_clients 8;/);
    assert.match(n, /proxy_read_timeout 30s;/);
    assert.doesNotMatch(n, /proxy_read_timeout 120s;/);
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
test('startup validates configuration and does not eval shell content', () => {
    const s = read('nginx/entrypoint.sh');
    assert.match(s, /envsubst '\$UPSTREAM_HOST \$UPSTREAM_PORT'/);
    assert.match(s, /nginx -t -c \/tmp\/llama-stack-bridge.conf/);
    assert.match(s, /\"--check\"/);
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

test('njs does not log request or response data', () => {
    const s = read('nginx/transform.js');
    assert.doesNotMatch(s, /\br\.error\(/);
    assert.doesNotMatch(s, /\br\.log\(/);
    assert.match(s, /reply\.responseBuffer\.length/);
    assert.match(s, /new Uint32Array\(4\)/);
    assert.doesNotMatch(s, /new Uint8Array\(16\)/);
});

// Validate the actual pre-interpolation shell code with fake environment values.
// No Nginx, Docker, real network or filesystem modifications are involved.
test('entrypoint rejects malformed DNS/IP values before substitution', () => {
    const entry = read('nginx/entrypoint.sh');
    const validation = entry.split('# Only substitute our two values;')[0];
    const preflight = validation + '\nexit 0\n';
    const accepted = ['mock', 'api.local', 'my-server', 'a.b-c.example',
        '127.0.0.1', '0.0.0.0', '255.255.255.255',
        'a'.repeat(63) + '.example'];
    const rejected = ['', 'bad..name', '.bad', 'bad.', '-bad', 'bad-',
        'a.-bad', 'bad-.local', 'a'.repeat(64)+'.local', '999.1.2.3',
        '256.1.2.3', '192.168.01.1', '1.2.3', '1.2.3.4.5',
        'host;echo', 'host/route', 'http://upstream', 'foo\nbar',
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
    const retainedMode = spawnSync('sh', ['-c',
        validation + '\ntest "$entrypoint_mode" = "--check"\n', '--', '--check'], {
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
