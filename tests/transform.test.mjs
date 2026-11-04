import test from 'node:test';
import assert from 'node:assert/strict';

let activeMock = null;
globalThis.ngx = {
    fetch: async (url, options) => {
        if (!activeMock) throw new Error('missing synthetic fetch fixture');
        const state = activeMock;
        state.response.upstreamRequest = { url, options };
        if (state.throwFetch) throw new Error('synthetic transport failure');
        const responseText = typeof state.upstream === 'string'
            ? state.upstream : JSON.stringify(state.upstream);
        if (Buffer.byteLength(responseText, 'utf8') > options.max_response_body_size) {
            if (state.allowOverCapText) {
                return { status: state.upstreamStatus, text: async () => responseText };
            }
            if (state.throwText) {
                return { status: state.upstreamStatus,
                    text: async () => { throw new Error('synthetic bounded fetch body read limit'); } };
            }
            throw new Error('synthetic bounded fetch response limit');
        }
        return { status: state.upstreamStatus, text: async () => responseText };
    }
};
const handlers = await import('../nginx/transform.js').then((module) => module.default);

async function run(handler, { method = 'POST', request = {}, upstreamStatus = 200,
    upstream = {}, throwFetch = false, throwText = false, allowOverCapText = false } = {}) {
    const response = { status: null, body: null, logs: [], upstreamRequest: null };
    activeMock = { response, upstreamStatus, upstream, throwFetch, throwText, allowOverCapText };
    const r = {
        method,
        requestText: typeof request === 'string' ? request : JSON.stringify(request),
        variables: {
            upstream_host: 'mock',
            upstream_models_url: 'http://127.0.0.1:8765/models/list',
            upstream_chat_url: 'http://127.0.0.1:8765/inference/chat_completion'
        },
        headersOut: {},
        error: (msg) => response.logs.push(msg),
        return: (status, body) => { response.status = status; response.body = body; }
    };
    try {
        await handler(r);
    } finally {
        activeMock = null;
    }
    response.json = () => JSON.parse(response.body);
    response.headers = r.headersOut;
    return response;
}
const valid = { model: 'fixture-model', messages: [{ role: 'user', content: 'private fixture text' }] };
const complete = { completion_message: {
    role: 'assistant', content: 'sample reply', stop_reason: 'end_of_turn', tool_calls: []
} };

test('chat maps pinned legacy response without assuming usage', async () => {
    const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    assert.equal(v.status, 200);
    assert.equal(v.json().choices[0].message.content, 'sample reply');
    assert.equal(v.json().choices[0].finish_reason, 'stop');
    assert.equal(Object.hasOwn(v.json(), 'usage'), false);
    assert.equal(v.upstreamRequest.url, 'http://127.0.0.1:8765/inference/chat_completion');
    assert.equal(v.upstreamRequest.options.headers.Host, 'mock');
    assert.equal(v.upstreamRequest.options.max_response_body_size, 1024 * 1024);
    assert.equal(JSON.parse(v.upstreamRequest.options.body).stream, false);
    assert.equal(JSON.parse(v.upstreamRequest.options.body).model, 'fixture-model');
    assert.equal(v.headers['Content-Type'], 'application/json');
    assert.deepEqual(v.logs, []);
});
test('chat never logs prompt, response or credentials', async () => {
    const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    assert.equal(v.logs.join(' ').includes('private fixture text'), false);
    assert.equal(v.logs.join(' ').includes('sample reply'), false);
});
test('stream is explicitly unsupported, without an upstream call', async () => {
    const v = await run(handlers.transform_chat_completion, { request: { ...valid, stream: true } });
    assert.equal(v.status, 501);
    assert.equal(v.upstreamRequest, null);
});
test('unrecognized tools and other options fail closed', async () => {
    for (const key of ['tools', 'tool_choice', 'response_format', 'n', 'user',
        'temperature', 'top_p', 'top_k', 'repeat_penalty']) {
        const v = await run(handlers.transform_chat_completion, { request: { ...valid, [key]: 'unused' } });
        assert.equal(v.status, 400, key);
        assert.equal(v.upstreamRequest, null, key);
    }
});
test('malformed JSON and missing fields are rejected', async () => {
    for (const request of ['[', [], {}, { model: 'm', messages: [] },
        { model: null, messages: [{ role: 'user', content: 'hi' }] }]) {
        assert.equal((await run(handlers.transform_chat_completion, { request })).status, 400);
    }
});
test('roles and multimodal message types fail closed', async () => {
    for (const messages of [[{ role: 'tool', content: 'x' }],
        [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        [{ role: 'user', content: 'x', tool_calls: [] }],
        [{ role: 'assistant', content: 'x', stop_reason: 10 }]]) {
        const v = await run(handlers.transform_chat_completion, {
            request: { model: 'm', messages }
        });
        assert.equal(v.status, 400);
    }
});
test('max_tokens is nested in legacy sampling_params, not sent top-level', async () => {
    const v = await run(handlers.transform_chat_completion, {
        request: { ...valid, max_tokens: 8 },
        upstream: complete
    });
    assert.equal(v.status, 200);
    const sent = JSON.parse(v.upstreamRequest.options.body);
    assert.deepEqual(sent.sampling_params, { max_tokens: 8 });
    assert.equal(Object.hasOwn(sent, 'max_tokens'), false);
    assert.equal(Object.hasOwn(sent, 'temperature'), false);
});
test('omitted optional sampling leaves upstream defaults intact', async () => {
    const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
    const sent = JSON.parse(v.upstreamRequest.options.body);
    assert.equal(Object.hasOwn(sent, 'sampling_params'), false);
});

test('numeric invalids fail before hitting upstream', async () => {
    for (const bad of [{temperature:-1}, {top_p:2}, {max_tokens:0},
        {top_k:1.2}, {repeat_penalty:null}]) {
        const v = await run(handlers.transform_chat_completion, { request: {...valid,...bad} });
        assert.equal(v.status, 400);
        assert.equal(v.upstreamRequest, null);
    }
});
test('assistant history is copied not mutated', async () => {
    const orig = { model: 'm', messages: [{ role: 'assistant', content: 'hello' }] };
    const v = await run(handlers.transform_chat_completion, { request: orig, upstream: complete });
    assert.equal(v.status, 200);
    assert.equal(orig.messages[0].stop_reason, undefined);
    assert.equal(JSON.parse(v.upstreamRequest.options.body).messages[0].stop_reason, 'end_of_turn');
    assert.deepEqual(JSON.parse(v.upstreamRequest.options.body).messages[0].tool_calls, []);
});
test('upstream failures return generic 502 without private data', async () => {
    const v = await run(handlers.transform_chat_completion, {
        request: valid, upstreamStatus: 401, upstream: 'secret: api token'
    });
    assert.equal(v.status, 502);
    assert.equal(v.body.includes('api token'), false);
});
test('upstream malformed completion is rejected as 502', async () => {
    for (const upstream of [{}, { completion_message: {role:'tool',content:'x'} },
        { completion_message: {role:'assistant',content: [{type:'image',url:'private'}],tool_calls:[]} }, '{']) {
        const v = await run(handlers.transform_chat_completion, { request: valid, upstream });
        assert.equal(v.status, 502);
    }
});
test('upstream tool calls are rejected instead of silently discarded', async () => {
    const response = { completion_message: { role: 'assistant', content: 'x',
        stop_reason: 'end_of_turn', tool_calls: [{ call_id: 'fixture-tool' }] } };
    const v = await run(handlers.transform_chat_completion, { request: valid, upstream: response });
    assert.equal(v.status, 502);
    assert.equal(v.json().error.type, 'invalid_upstream_response');
});

test('supported legacy text arrays become simple text', async () => {
    const v = await run(handlers.transform_chat_completion, { request: valid,
        upstream: { completion_message: { role:'assistant', stop_reason:'out_of_tokens',
            tool_calls: [], content:['a','b'] } } });
    assert.equal(v.status, 200);
    assert.equal(v.json().choices[0].message.content, 'ab');
    assert.equal(v.json().choices[0].finish_reason, 'length');
});
test('legacy ImageMedia completion content is rejected by the text-only bridge', async () => {
    const upstream = { completion_message: { role: 'assistant', stop_reason: 'end_of_turn',
        tool_calls: [], content: { type: 'image', url: 'fixture-private-image' } } };
    const v = await run(handlers.transform_chat_completion, { request: valid, upstream });
    assert.equal(v.status, 502);
    assert.equal(v.json().error.type, 'invalid_upstream_response');
    assert.equal(v.body.includes('fixture-private-image'), false);
});

test('chat requires POST', async () => {
    assert.equal((await run(handlers.transform_chat_completion, { method:'GET', request: valid })).status, 405);
});
test('model listing normalizes identifier and provider', async () => {
    const v = await run(handlers.transform_models, { method:'GET',
        upstream:[{identifier:'m1',provider_id:'vendor'},{id:'m2'}] });
    assert.equal(v.status, 200);
    assert.deepEqual(v.json().data.map(x => x.id), ['m1', 'm2']);
    assert.equal(v.json().data[1].owned_by, 'llama-stack');
    assert.equal(v.upstreamRequest.url, 'http://127.0.0.1:8765/models/list');
    assert.equal(v.upstreamRequest.options.headers.Host, 'mock');
    assert.equal(v.upstreamRequest.options.max_response_body_size, 1024 * 1024);
});
test('model listing fails cleanly on errors and invalid JSON', async () => {
    for (const upstream of ['{', {notModels:true}, [{foo:'bar'}]]) {
        assert.equal((await run(handlers.transform_models, {method:'GET',upstream})).status, 502);
    }
    assert.equal((await run(handlers.transform_models, {method:'GET',upstreamStatus:503})).status, 502);
});
test('model listing requires GET', async () => {
    assert.equal((await run(handlers.transform_models, {method:'POST'})).status, 405);
});

test('transport dispatch exceptions fail closed without leaking internals', async () => {
    const chat = await run(handlers.transform_chat_completion,
        {request: valid, throwFetch:true});
    const models = await run(handlers.transform_models,
        {method:'GET', throwFetch:true});
    assert.equal(chat.status, 502);
    assert.equal(models.status, 502);
    assert.equal(chat.body.includes('synthetic transport'), false);
});

test('unknown and missing upstream stop reason fail closed without completion', async () => {
    for (const stop_reason of ['unknown_future_reason', null, 42, undefined]) {
        const response = { ...complete, completion_message: {
            ...complete.completion_message, stop_reason } };
        const v = await run(handlers.transform_chat_completion, { request: valid, upstream: response });
        assert.equal(v.status, 502, String(stop_reason));
        assert.equal(v.json().error.type, 'invalid_upstream_response');
        assert.equal(v.body.includes('unknown_future_reason'), false);
    }
});

test('completion IDs use cryptographically sourced 128-bit hex without timestamps', async () => {
    const ids = new Set();
    for (let i = 0; i < 32; i++) {
        const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 200);
        const id = v.json().id;
        assert.match(id, /^chatcmpl-[a-f0-9]{32}$/);
        ids.add(id);
    }
    assert.equal(ids.size, 32);
});

test('exact 1 MiB upstream response is accepted at the inclusive byte boundary', async () => {
    const prefix = JSON.stringify({ data: [] });
    const exact = prefix + ' '.repeat(1024 * 1024 - Buffer.byteLength(prefix, 'utf8'));
    assert.equal(Buffer.byteLength(exact, 'utf8'), 1024 * 1024);
    const v = await run(handlers.transform_models, { method: 'GET', upstream: exact });
    assert.equal(v.status, 200);
    assert.deepEqual(v.json(), { object: 'list', data: [] });
});

test('synthetic oversized upstream text fails closed before JSON parsing', async () => {
    const over = 'x'.repeat(1024 * 1024 + 1);
    for (const [handler, method, request] of [
        [handlers.transform_models, 'GET', {}],
        [handlers.transform_chat_completion, 'POST', valid]]) {
        const v = await run(handler, { method, request, upstream: over });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'upstream_error');
        assert.equal(v.body.includes(over.slice(0, 50)), false);
    }
});

test('chunked fetch bodies over 1 MiB are rejected before JSON parsing', async () => {
    const over = 'x'.repeat(1024 * 1024 + 1);
    for (const [handler, method, request] of [
        [handlers.transform_models, 'GET', {}],
        [handlers.transform_chat_completion, 'POST', valid]]) {
        const v = await run(handler, { method, request, upstream: over, allowOverCapText: true });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'upstream_error');
        assert.equal(v.body.includes(over.slice(0, 50)), false);
    }
});

test('oversized streamed fetch body read fails closed as upstream_error', async () => {
    const over = 'x'.repeat(1024 * 1024 + 1);
    for (const [handler, method, request] of [
        [handlers.transform_models, 'GET', {}],
        [handlers.transform_chat_completion, 'POST', valid]]) {
        const v = await run(handler, { method, request, upstream: over, throwText: true });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'upstream_error');
        assert.equal(v.body.includes(over.slice(0, 50)), false);
    }
});

test('missing secure random API fails closed without predictable ID fallback', async () => {
    const existing = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
        Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
        const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 502);
        assert.equal(v.json().error.type, 'invalid_upstream_response');
        assert.equal(v.body.includes('random'), false);
    } finally {
        if (existing) Object.defineProperty(globalThis, 'crypto', existing);
        else delete globalThis.crypto;
    }
});


test('completion ID requests documented njs-compatible Uint32Array entropy', async () => {
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
        const v = await run(handlers.transform_chat_completion, { request: valid, upstream: complete });
        assert.equal(v.status, 200);
        assert.equal(v.json().id, 'chatcmpl-0000000000000001abcdef01ffffffff');
        assert.equal(calls, 1);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
    }
});

test('UTF-8 multibyte upstream exceeds raw byte cap despite short text length', async () => {
    const oversized = JSON.stringify({completion_message: {role: 'assistant',
        content: '🌿'.repeat(300000), stop_reason: 'end_of_turn'}});
    assert.ok(oversized.length < 1024 * 1024, 'text length is below raw byte cap');
    assert.ok(Buffer.byteLength(oversized, 'utf8') > 1024 * 1024, 'UTF-8 bytes exceed cap');
    const v = await run(handlers.transform_chat_completion, {request: valid, upstream: oversized});
    assert.equal(v.status, 502);
    assert.equal(v.json().error.type, 'upstream_error');
    assert.equal(v.body.includes('🌿'), false);
});
