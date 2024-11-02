var buffer = '';
// Transformation function for models
function transform_models(r) {
    r.subrequest('/v1/models_raw', (reply) => {
        if (reply.status !== 200) {
            r.return(502, "Bad Gateway: Upstream service error");
            return;
        }

        try {
            // Parse JSON response from upstream
            const llamaResponse = JSON.parse(reply.responseText);

            const openaiResponse = {
                data: llamaResponse.map(function(model) {
                    return {
                        id: model.identifier,
                        object: 'model',
                        created: Math.floor(Date.now() / 1000),
                        owned_by: model.provider_id || "openai"
                    };
                }),
                object: 'list'
            };

            r.return(200, JSON.stringify(openaiResponse));
        } catch (e) {
            r.error(`Transformation failed: ${e.message}`);
            r.return(500, "Internal Server Error: Transformation failure");
        }
    });
}

function transform_chat_completion(r) {
    try {
        const requestBody = JSON.parse(r.requestText);
        r.error(`Received Request Body: ${JSON.stringify(requestBody)}`);

        // Validate that 'messages' is an array
        if (!Array.isArray(requestBody.messages)) {
            r.return(400, JSON.stringify({ error: "'messages' must be an array." }));
            return;
        }

        // Validate roles in messages using traditional for loop
        for (var i = 0; i < requestBody.messages.length; i++) {
            var msg = requestBody.messages[i];
            if (!['user', 'assistant', 'system'].includes(msg.role)) {
                r.return(400, JSON.stringify({ error: `Invalid role '${msg.role}' in messages.` }));
                return;
            }

            // If the role is 'assistant' and 'stop_reason' is not present, add it
            if (msg.role === 'assistant' && !msg.stop_reason) {
                msg.stop_reason = 'end_of_turn';  // You can set this to any appropriate value
            }
        }

        // Define the payload with Llama Stack-specific parameters, adding defaults if needed
        var strippedPayload = {
            model: requestBody.model,
            messages: requestBody.messages,  // Now includes 'stop_reason' for 'assistant' roles - required by llamastack
            stream: requestBody.stream || false, // Todo support stream=true
            max_tokens: requestBody.max_tokens || 128,
            temperature: requestBody.temperature || 0.7,
            top_k: requestBody.top_k || 50,
            top_p: requestBody.top_p || 0.9,
            repeat_penalty: requestBody.repeat_penalty || 1.05
        };

        r.error(`Stripped Payload: ${JSON.stringify(strippedPayload)}`);  // Log payload for debugging

        // Make subrequest to upstream service
        r.subrequest(
            '/inference/chat_completion',
            {
                method: 'POST',
                body: JSON.stringify(strippedPayload),
                headers: { 'Content-Type': 'application/json' }
            },
            (reply) => {
                r.error(`Upstream Response Status: ${reply.status}`);
                r.error(`Upstream Response Body: ${reply.responseText}`);

                if (reply.status !== 200) {
                    r.return(502, "Bad Gateway: Upstream service error");
                    return;
                }

                try {
                    const upstreamResponse = JSON.parse(reply.responseText);
                    r.error(`Parsed Upstream Response: ${JSON.stringify(upstreamResponse)}`);

                    // Validate upstreamResponse structure
                    if (!upstreamResponse.completion_message) {
                        throw new Error("Missing 'completion_message' in upstream response.");
                    }

                    var openaiResponse = {
                        id: "chatcmpl-" + Math.random().toString(36).substring(2),
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000),
                        model: strippedPayload.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: upstreamResponse.completion_message.role,
                                    content: upstreamResponse.completion_message.content
                                },
                                finish_reason: upstreamResponse.completion_message.stop_reason || "stop"
                            }
                        ],
                        usage: upstreamResponse.usage || {} // Populate if available
                    };

                    r.error(`Transformed OpenAI Response: ${JSON.stringify(openaiResponse)}`);
                    r.return(200, JSON.stringify(openaiResponse));
                } catch (e) {
                    r.error(`Transformation failed: ${e.message}`);
                    r.return(500, "Internal Server Error: Transformation failure");
                }
            }
        );
    } catch (e) {
        r.error(`Failed to parse request body: ${e.message}`);
        r.return(400, "Bad Request: Invalid JSON in request body");
    }
}


export default { transform_models, transform_chat_completion };

