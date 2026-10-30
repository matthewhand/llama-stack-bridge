// njs handlers for a deliberately small legacy Llama Stack API subset.
// No request, response, authorization header or prompt content is logged.
// Check raw upstream bytes before decoding/parsing; JavaScript string length
// is measured in UTF-16 code units and cannot enforce a UTF-8 byte cap.
const MAX_UPSTREAM_BYTES = 1024 * 1024;
function failure(r, status, type, message) {
    r.headersOut['Content-Type'] = 'application/json';
    r.return(status, JSON.stringify({ error: { type: type, message: message } }));
}

function success(r, payload) {
    r.headersOut['Content-Type'] = 'application/json';
    r.return(200, JSON.stringify(payload));
}

function boundedReplyText(reply) {
    // njs exposes responseBuffer for subrequests; its length is raw bytes.
    // Fail closed rather than relying on a text-character approximation.
    if (!reply.responseBuffer || typeof reply.responseBuffer.length !== 'number' ||
        reply.responseBuffer.length > MAX_UPSTREAM_BYTES ||
        typeof reply.responseText !== 'string') {
        throw new Error('invalid upstream size');
    }
    return reply.responseText;
}

// njs must expose a secure random source; never silently fall back to Math.random.
function completionId() {
    if (typeof crypto === 'undefined' ||
        typeof crypto.getRandomValues !== 'function') {
        throw new Error('secure random source unavailable');
    }
    // Uint32Array is explicitly supported in the njs Web Crypto API.
    // Four independent 32-bit words provide 128 bits of entropy.
    var words = new Uint32Array(4);
    crypto.getRandomValues(words);
    var hex = '';
    for (var i = 0; i < words.length; i++) {
        hex += ('00000000' + words[i].toString(16)).slice(-8);
    }
    return 'chatcmpl-' + hex;
}

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function transform_models(r) {
    if (r.method !== 'GET') {
        failure(r, 405, 'method_not_allowed', 'Use GET for model listing.');
        return;
    }
    try {
        r.subrequest('/__upstream_models', function(reply) {
        if (reply.status !== 200) {
            failure(r, 502, 'upstream_error', 'Model-list upstream unavailable.');
            return;
        }
        try {
            var raw = JSON.parse(boundedReplyText(reply));
            var models = Array.isArray(raw) ? raw : (plainObject(raw) ? raw.data : null);
            if (!Array.isArray(models)) {
                throw new Error('models response is not an array');
            }
            var result = models.map(function(model) {
                if (!plainObject(model)) {
                    throw new Error('invalid model entry');
                }
                var id = model.identifier || model.id;
                if (typeof id !== 'string' || !id) {
                    throw new Error('missing model identifier');
                }
                return {
                    id: id,
                    object: 'model',
                    owned_by: (typeof model.provider_id === 'string' && model.provider_id)
                        ? model.provider_id : 'llama-stack'
                };
            });
            success(r, { object: 'list', data: result });
        } catch (e) {
            failure(r, 502, 'invalid_upstream_response', 'Unrecognized model-list response.');
        }
        });
    } catch (e) {
        failure(r, 502, 'upstream_error', 'Model-list upstream unavailable.');
    }
}

function validNumber(x, min, max, integer) {
    return typeof x === 'number' && Number.isFinite(x) &&
        x >= min && x <= max && (!integer || Number.isInteger(x));
}

function finishReason(reason) {
    if (reason === 'end_of_turn' || reason === 'end_of_message' || reason === 'stop') {
        return 'stop';
    }
    if (reason === 'out_of_tokens' || reason === 'length') {
        return 'length';
    }
    return null;
}

function textContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.length > 0 &&
        content.every(function(part) {
            return plainObject(part) && part.type === 'text' && typeof part.text === 'string';
        })) {
        return content.map(function(part) { return part.text; }).join('');
    }
    return null;
}

function normalizeUsage(u) {
    if (!plainObject(u)) return null;
    var prompt = u.prompt_tokens !== undefined ? u.prompt_tokens : u.input_tokens;
    var completion = u.completion_tokens !== undefined ? u.completion_tokens : u.output_tokens;
    if (!validNumber(prompt, 0, 1e12, true) || !validNumber(completion, 0, 1e12, true)) {
        return null;
    }
    return { prompt_tokens: prompt, completion_tokens: completion,
        total_tokens: prompt + completion };
}

function transform_chat_completion(r) {
    if (r.method !== 'POST') {
        failure(r, 405, 'method_not_allowed', 'Use POST for chat completions.');
        return;
    }
    var input;
    try {
        input = JSON.parse(r.requestText);
    } catch (e) {
        failure(r, 400, 'invalid_request_error', 'Expected a JSON request body.');
        return;
    }
    if (!plainObject(input) || typeof input.model !== 'string' || !input.model.trim() ||
        !Array.isArray(input.messages) || input.messages.length < 1) {
        failure(r, 400, 'invalid_request_error', 'A model and nonempty messages array are required.');
        return;
    }
    // Reject unsupported features rather than silently losing important semantics.
    // The pinned 2024 legacy schema nests supported generation limits under
    // sampling_params. Other sampling strategies require separate validation.
    var supported = ['model', 'messages', 'stream', 'max_tokens'];
    var inputKeys = Object.keys(input);
    for (var keyIndex = 0; keyIndex < inputKeys.length; keyIndex++) {
        var key = inputKeys[keyIndex];
        if (supported.indexOf(key) < 0) {
            failure(r, 400, 'unsupported_parameter', 'Unsupported request field: ' + key);
            return;
        }
    }
    if (input.stream !== undefined && typeof input.stream !== 'boolean') {
        failure(r, 400, 'invalid_request_error', 'stream must be a boolean.');
        return;
    }
    if (input.stream === true) {
        failure(r, 501, 'not_implemented', 'Streaming is not implemented.');
        return;
    }
    var nums = [['max_tokens', 1, 1000000, true]];
    for (var paramIndex = 0; paramIndex < nums.length; paramIndex++) {
        var param = nums[paramIndex];
        var value = input[param[0]];
        if (value !== undefined && !validNumber(value, param[1], param[2], param[3])) {
            failure(r, 400, 'invalid_request_error', 'Invalid ' + param[0] + '.');
            return;
        }
    }
    var messages = [];
    for (var messageIndex = 0; messageIndex < input.messages.length; messageIndex++) {
        var msg = input.messages[messageIndex];
        if (!plainObject(msg) ||
            ['system', 'user', 'assistant'].indexOf(msg.role) < 0 ||
            typeof msg.content !== 'string') {
            failure(r, 400, 'invalid_request_error', 'Only text-only system, user and assistant messages are supported.');
            return;
        }
        var messageKeys = Object.keys(msg);
        for (var fieldIndex = 0; fieldIndex < messageKeys.length; fieldIndex++) {
            var mk = messageKeys[fieldIndex];
            if (['role', 'content', 'stop_reason'].indexOf(mk) < 0) {
                failure(r, 400, 'unsupported_parameter', 'Unsupported message field: ' + mk);
                return;
            }
        }
        if (msg.stop_reason !== undefined && (msg.role !== 'assistant' ||
            typeof msg.stop_reason !== 'string')) {
            failure(r, 400, 'invalid_request_error', 'Invalid assistant stop_reason.');
            return;
        }
        var forwarded = { role: msg.role, content: msg.content };
        if (msg.role === 'assistant') forwarded.stop_reason = msg.stop_reason || 'end_of_turn';
        messages.push(forwarded);
    }
    var upstream = { model: input.model, messages: messages, stream: false };
    if (input.max_tokens !== undefined) {
        upstream.sampling_params = { max_tokens: input.max_tokens };
    }
    try {
        r.subrequest('/__upstream_chat', {
        method: 'POST',
        body: JSON.stringify(upstream)
    }, function(reply) {
        if (reply.status !== 200) {
            failure(r, 502, 'upstream_error', 'Chat upstream unavailable.');
            return;
        }
        try {
            var raw = JSON.parse(boundedReplyText(reply));
            if (!plainObject(raw) || !plainObject(raw.completion_message) ||
                raw.completion_message.role !== 'assistant') {
                throw new Error('missing assistant completion');
            }
            var content = textContent(raw.completion_message.content);
            if (content === null) throw new Error('unsupported completion content');
            var reason = finishReason(raw.completion_message.stop_reason);
            if (reason === null) {
                throw new Error('unknown upstream termination');
            }
            var output = {
                id: completionId(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: input.model,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: content },
                    finish_reason: reason
                }]
            };
            var usage = normalizeUsage(raw.usage);
            if (usage !== null) output.usage = usage;
            success(r, output);
        } catch (e) {
            failure(r, 502, 'invalid_upstream_response', 'Unrecognized chat completion response.');
        }
        });
    } catch (e) {
        failure(r, 502, 'upstream_error', 'Chat upstream unavailable.');
    }
}

export default { transform_models, transform_chat_completion };
