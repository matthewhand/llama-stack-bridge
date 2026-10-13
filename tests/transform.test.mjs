import test from 'node:test';
import assert from 'node:assert/strict';
import handlers from '../nginx/transform.js';

function run(handler, { method = 'POST', request = {}, upstreamStatus = 200,
    upstream = {} } = {}) {
    const response = { status: null, body: null, logs: [], upstreamRequest: null };
    const r = {
        method, requestText: typeof request === 'string' ? request : JSON.stringify(request),
        headersOut: {},
        error: (msg) => response.logs.push(msg),
        return: (status, body) => { response.status = status; response.body = body; },
        subrequest: (path, options, cb) => {
            if (typeof options === 'function') { cb = options; options = {}; }
            response.upstreamRequest = { path, options };
            cb({ status: upstreamStatus, responseText: typeof upstream === 'string'
                ? upstream : JSON.stringify(upstream) });
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
    for (const key of ['tools', 'tool_choice', 'response_format', 'n', 'user']) {
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
test('zero temperature is preserved without default substitution', () => {
    const v = run(handlers.transform_chat_completion, {
        request: { ...valid, temperature: 0, top_p: 0, max_tokens: 8 },
        upstream: complete
    });
    const sent = JSON.parse(v.upstreamRequest.options.body);
    assert.equal(sent.temperature, 0);
    assert.equal(sent.top_p, 0);
    assert.equal(sent.max_tokens, 8);
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
