import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('Dockerfile uses packaged nginx/njs with unprivileged runtime', () => {
    const d = read('nginx/Dockerfile');
    assert.match(d, /^ARG ALPINE_BASE=alpine:3\.22$/m);
    assert.match(d, /^FROM \$\{ALPINE_BASE\}$/m);
    assert.match(d, /nginx-mod-http-js/);
    assert.match(d, /gettext-envsubst/);
    assert.match(d, /^USER nginx$/m);
    assert.doesNotMatch(d, /wget http:|git clone|ubuntu:20\.04/);
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
});
test('Compose stays loopback-bound and drops capabilities', () => {
    const c = read('docker-compose.yaml');
    assert.match(c, /127\.0\.0\.1:42070:8080/);
    assert.match(c, /read_only: true/);
    assert.match(c, /no-new-privileges:true/);
    assert.match(c, /cap_drop:/);
    assert.match(c, /pids_limit: 64/);
    assert.doesNotMatch(c, /"\s*42070:80"/);
});
test('startup validates configuration and does not eval shell content', () => {
    const s = read('nginx/entrypoint.sh');
    assert.match(s, /envsubst '\$UPSTREAM_HOST \$UPSTREAM_PORT'/);
    assert.match(s, /nginx -t -c \/tmp\/llama-stack-bridge.conf/);
    assert.match(s, /\"--check\"/);
    assert.match(s, /Invalid UPSTREAM_HOST/);
    assert.match(s, /Invalid UPSTREAM_PORT/);
    assert.doesNotMatch(s, /\beval\b/);
});
test('njs does not log request or response data', () => {
    const s = read('nginx/transform.js');
    assert.doesNotMatch(s, /\br\.error\(/);
    assert.doesNotMatch(s, /\br\.log\(/);
});
