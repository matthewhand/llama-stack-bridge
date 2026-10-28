import test from 'node:test';
import assert from 'node:assert/strict';
import handlers from '../nginx/transform.js';

function run(handler, { method = 'POST', request = {}, upstreamStatus = 200,
    upstream = {}, throwSubrequest = false } = {}) {
    const response = { status: null, body: null, logs: [], upstreamRequest: null };
    const r = {
        method, requestText: typeof request === 'string' ? request : JSON.stringify(request),
        headersOut: {},
        error: (msg) => response.logs.push(msg),
        return: (status, body) => { response.status = status; response.body = body; },
        subrequest: (path, options, cb) => {
            if (throwSubrequest) throw Error('synthetic transport failure');
            if (typeof options === 'function') { cb = options; options = {}; }
            response.upstreamRequest = { path, options };
            const responseText = typeof upstream === 'string'
                ? upstream : JSON.stringify(upstream);
            cb({ status: upstreamStatus, responseText,
                responseBuffer: Buffer.from(responseText, 'utf8') });
        }
    };
    handler(r);
    response.json = () => JSON.parse(response.body);
    response.headers = r.headersOut;
    return response;
}
const valid = { model: 'fixture-model', messages: [{ role: 'user', content: 'private fixture text' }] };
const complete = { completion_message: {
    role: 'assistant', content: 'sample reply', stop_reason: 'end_of_turn'
}, usage: { input_tokens: 4, output_tokens: 7 } };

test('chat maps legacy response and normalizes usage', () => {
    const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    assert.equal(v.status, 200);
    assert.equal(v.json().choices[0].message.content, 'sample reply');
    assert.equal(v.json().choices[0].finish_reason, 'stop');
    assert.deepEqual(v.json().usage, { prompt_tokens: 4, completion_tokens: 7, total_tokens: 11 });
    assert.equal(v.upstreamRequest.path, '/__upstream_chat');
    assert.equal(JSON.parse(v.upstreamRequest.options.body).stream, false);
    assert.equal(v.headers['Content-Type'], 'application/json');
    assert.deepEqual(v.logs, []);
});
test('chat never logs prompt, response or credentials', () => {
    const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    assert.equal(v.logs.join(' ').includes('private fixture text'), false);
    assert.equal(v.logs.join(' ').includes('sample reply'), false);
});
test('stream is explicitly unsupported, without an upstream call', () => {
    const v = run(handlers.transform_chat_completion, { request: { ...valid, stream: true } });
    assert.equal(v.status, 501);
    assert.equal(v.upstreamRequest, null);
});
test('unrecognized tools and other options fail closed', () => {
    for (const key of ['tools', 'tool_choice', 'response_format', 'n', 'user',
        'temperature', 'top_p', 'top_k', 'repeat_penalty']) {
        const v = run(handlers.transform_chat_completion, { request: { ...valid, [key]: 'unused' } });
        assert.equal(v.status, 400, key);
        assert.equal(v.upstreamRequest, null, key);
    }
});
test('malformed JSON and missing fields are rejected', () => {
    for (const request of ['[', [], {}, { model: 'm', messages: [] },
        { model: null, messages: [{ role: 'user', content: 'hi' }] }]) {
        assert.equal(run(handlers.transform_chat_completion, { request }).status, 400);
    }
});
test('roles and multimodal message types fail closed', () => {
    for (const messages of [[{ role: 'tool', content: 'x' }],
        [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        [{ role: 'user', content: 'x', tool_calls: [] }],
        [{ role: 'assistant', content: 'x', stop_reason: 10 }]]) {
        const v = run(handlers.transform_chat_completion, {
            request: { model: 'm', messages }
        });
        assert.equal(v.status, 400);
    }
});
test('max_tokens is nested in legacy sampling_params, not sent top-level', () => {
    const v = run(handlers.transform_chat_completion, {
        request: { ...valid, max_tokens: 8 },
        upstream: complete
    });
    assert.equal(v.status, 200);
    const sent = JSON.parse(v.upstreamRequest.options.body);
    assert.deepEqual(sent.sampling_params, { max_tokens: 8 });
    assert.equal(Object.hasOwn(sent, 'max_tokens'), false);
    assert.equal(Object.hasOwn(sent, 'temperature'), false);
});
test('omitted optional sampling leaves upstream defaults intact', () => {
    const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    const sent = JSON.parse(v.upstreamRequest.options.body);
    assert.equal(Object.hasOwn(sent, 'sampling_params'), false);
});

test('numeric invalids fail before hitting upstream', () => {
    for (const bad of [{temperature:-1}, {top_p:2}, {max_tokens:0},
        {top_k:1.2}, {repeat_penalty:null}]) {
        const v = run(handlers.transform_chat_completion, { request: {...valid,...bad} });
        assert.equal(v.status, 400);
        assert.equal(v.upstreamRequest, null);
    }
});
test('assistant history is copied not mutated', () => {
    const orig = { model: 'm', messages: [{ role: 'assistant', content: 'hello' }] };
    const v = run(handlers.transform_chat_completion, { request: orig, upstream: complete });
    assert.equal(v.status, 200);
    assert.equal(orig.messages[0].stop_reason, undefined);
    assert.equal(JSON.parse(v.upstreamRequest.options.body).messages[0].stop_reason, 'end_of_turn');
});
test('upstream failures return generic 502 without private data', () => {
    const v = run(handlers.transform_chat_completion, {
        request: valid, upstreamStatus: 401, upstream: 'secret: api token'
    });
    assert.equal(v.status, 502);
    assert.equal(v.body.includes('api token'), false);
});
test('upstream malformed completion is rejected as 502', () => {
    for (const upstream of [{}, { completion_message: {role:'tool',content:'x'} },
        { completion_message: {role:'assistant',content: [{type:'image',url:'private'}]} }, '{']) {
        const v = run(handlers.transform_chat_completion, { request: valid, upstream });
        assert.equal(v.status, 502);
    }
});
test('supported text-part responses become simple text', () => {
    const v = run(handlers.transform_chat_completion, { request: valid,
        upstream: { completion_message: { role:'assistant', stop_reason:'out_of_tokens',
            content:[{type:'text',text:'a'},{type:'text',text:'b'}] } } });
    assert.equal(v.status, 200);
    assert.equal(v.json().choices[0].message.content, 'ab');
    assert.equal(v.json().choices[0].finish_reason, 'length');
});
test('chat requires POST', () => {
    assert.equal(run(handlers.transform_chat_completion, { method:'GET', request: valid }).status, 405);
});
test('model listing normalizes identifier and provider', () => {
    const v = run(handlers.transform_models, { method:'GET',
        upstream:[{identifier:'m1',provider_id:'vendor'},{id:'m2'}] });
    assert.equal(v.status, 200);
    assert.deepEqual(v.json().data.map(x => x.id), ['m1', 'm2']);
    assert.equal(v.json().data[1].owned_by, 'llama-stack');
    assert.equal(v.upstreamRequest.path, '/__upstream_models');
});
test('model listing fails cleanly on errors and invalid JSON', () => {
    for (const upstream of ['{', {notModels:true}, [{foo:'bar'}]]) {
        assert.equal(run(handlers.transform_models, {method:'GET',upstream}).status, 502);
    }
    assert.equal(run(handlers.transform_models, {method:'GET',upstreamStatus:503}).status, 502);
});
test('model listing requires GET', () => {
    assert.equal(run(handlers.transform_models, {method:'POST'}).status, 405);
});

test('transport dispatch exceptions fail closed without leaking internals', () => {
    const chat = run(handlers.transform_chat_completion,
        {request: valid, throwSubrequest:true});
    const models = run(handlers.transform_models,
        {method:'GET', throwSubrequest:true});
    assert.equal(chat.status, 502);
    assert.equal(models.status, 502);
    assert.equal(chat.body.includes('synthetic transport'), false);
});

test('unknown and missing upstream stop reason fail closed without completion', () => {
    for (const stop_reason of ['unknown_future_reason', null, 42, undefined]) {
        const response = { ...complete, completion_message: {
            ...complete.completion_message, stop_reason } };
        const v = run(handlers.transform_chat_completion, { request: valid, upstream: response });
        assert.equal(v.status, 502, String(stop_reason));
        assert.equal(v.json().error.type, 'invalid_upstream_response');
        assert.equal(v.body.includes('unknown_future_reason'), false);
    }
});

test('completion IDs use cryptographically sourced 128-bit hex without timestamps', () => {
    const ids = new Set();
    for (let i = 0; i < 32; i++) {
        const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 200);
        const id = v.json().id;
        assert.match(id, /^chatcmpl-[a-f0-9]{32}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 32);
});

test('synthetic oversized upstream text fails closed before JSON parsing', () => {
    const over = 'x'.repeat(1024 * 1024 + 1);
    for (const [handler, method, request] of [
        [handlers.transform_models, 'GET', {}],
        [handlers.transform_chat_completion, 'POST', valid]]) {
        const v = run(handler, { method, request, upstream: over });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'invalid_upstream_response');
        assert.equal(v.body.includes(over.slice(0, 50)), false);
    }
});

test('missing secure random API fails closed without predictable ID fallback', () => {
    const existing = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
        const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'invalid_upstream_response');
        assert.equal(v.body.includes('random'), false);
    } finally {
        if (existing) Object.defineProperty(globalThis, 'crypto', existing);
        else delete globalThis.crypto;
    }
});


test('completion ID requests documented njs-compatible Uint32Array entropy', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    let calls = 0;
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true,
            value: { getRandomValues: (values) => {
                assert.equal(values.constructor, Uint32Array);
                assert.equal(values.length, 4);
                calls++;
                values.set([0, 1, 0xabcdef01, 0xffffffff]);
                return values;
            } } });
        const v = run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 200);
        assert.equal(v.json().id, 'chatcmpl-0000000000000001abcdef01ffffffff');
        assert.equal(calls, 1);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
    }
});

test('UTF-8 multibyte upstream exceeds raw byte cap despite short text length', () => {
    const oversized = JSON.stringify({completion_message: {role: 'assistant',
        content: '🌿'.repeat(300000), stop_reason: 'end_of_turn'}});
    assert.ok(oversized.length < 1024 * 1024, 'text length is below raw byte cap');
    assert.ok(Buffer.byteLength(oversized, 'utf8') > 1024 * 1024, 'UTF-8 bytes exceed cap');
    const v = run(handlers.transform_chat_completion, {request: valid, upstream: oversized});
    assert.equal(v.status, 502);
    assert.equal(v.json().error.type, 'invalid_upstream_response');
    assert.equal(v.body.includes('🌿'), false);
});
