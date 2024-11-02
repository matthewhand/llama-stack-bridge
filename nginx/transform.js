// Buffer variable declared for potential use in future features.
var buffer = '';

// Function to transform model data returned by the Llama Stack API to OpenAI-compatible format.
function transform_models(r) {
    // Make a subrequest to retrieve raw model data.
    r.subrequest('/v1/models_raw', (reply) => {
        // Check if the upstream service response is successful.
        if (reply.status !== 200) {
            r.return(502, "Bad Gateway: Upstream service error");
            return;
        }

        try {
            // Parse the JSON response from the upstream service.
            const llamaResponse = JSON.parse(reply.responseText);

            // Map Llama Stack model format to OpenAI's expected response structure.
            const openaiResponse = {
                data: llamaResponse.map(function(model) {
                    return {
                        id: model.identifier, // Unique model ID.
                        object: 'model',
                        created: Math.floor(Date.now() / 1000), // Current timestamp.
                        owned_by: model.provider_id || "openai" // Fallback if provider ID is not present.
                    };
                }),
                object: 'list' // Indicates the response type.
            };

            // Return the transformed response with a 200 OK status.
            r.return(200, JSON.stringify(openaiResponse));
        } catch (e) {
            // Log and return an error if JSON parsing or transformation fails.
            r.error(`Transformation failed: ${e.message}`);
            r.return(500, "Internal Server Error: Transformation failure");
        }
    });
}

// Function to transform chat completion requests and responses.
function transform_chat_completion(r) {
    try {
        // Parse the incoming request body to ensure it is valid JSON.
        const requestBody = JSON.parse(r.requestText);
        r.error(`Received Request Body: ${JSON.stringify(requestBody)}`); // Debug log.

        // Validate the 'messages' field to ensure it is an array.
        if (!Array.isArray(requestBody.messages)) {
            r.return(400, JSON.stringify({ error: "'messages' must be an array." }));
            return;
        }

        // Validate roles in each message and add 'stop_reason' if missing for 'assistant' roles.
        for (var i = 0; i < requestBody.messages.length; i++) {
            var msg = requestBody.messages[i];
            if (!['user', 'assistant', 'system'].includes(msg.role)) {
                // Return an error if an invalid role is detected.
                r.return(400, JSON.stringify({ error: `Invalid role '${msg.role}' in messages.` }));
                return;
            }

            // Assign a default 'stop_reason' for 'assistant' roles if not provided.
            if (msg.role === 'assistant' && !msg.stop_reason) {
                msg.stop_reason = 'end_of_turn'; // Customizable based on specific needs.
            }
        }

        // Construct the payload for the upstream service, ensuring required defaults.
        var strippedPayload = {
            model: requestBody.model,
            messages: requestBody.messages,
            stream: requestBody.stream || false, // Default to false if not provided.
            max_tokens: requestBody.max_tokens || 128, // Default token limit.
            temperature: requestBody.temperature || 0.7, // Default temperature setting.
            top_k: requestBody.top_k || 50, // Default top_k value for sampling.
            top_p: requestBody.top_p || 0.9, // Default top_p value for nucleus sampling.
            repeat_penalty: requestBody.repeat_penalty || 1.05 // Default repeat penalty to avoid repetition.
        };

        r.error(`Stripped Payload: ${JSON.stringify(strippedPayload)}`); // Debug log for verification.

        // Send the modified request to the upstream Llama Stack API.
        r.subrequest(
            '/inference/chat_completion',
            {
                method: 'POST',
                body: JSON.stringify(strippedPayload),
                headers: { 'Content-Type': 'application/json' }
            },
            (reply) => {
                r.error(`Upstream Response Status: ${reply.status}`); // Log response status for debugging.
                r.error(`Upstream Response Body: ${reply.responseText}`); // Log the full response for analysis.

                if (reply.status !== 200) {
                    // Return a 502 status if the upstream response indicates an error.
                    r.return(502, "Bad Gateway: Upstream service error");
                    return;
                }

                try {
                    // Parse the upstream response.
                    const upstreamResponse = JSON.parse(reply.responseText);
                    if (!upstreamResponse.completion_message) {
                        throw new Error("Missing 'completion_message' in upstream response.");
                    }

                    // Construct the OpenAI-compatible response format.
                    var openaiResponse = {
                        id: "chatcmpl-" + Math.random().toString(36).substring(2), // Generate a unique ID.
                        object: "chat.completion",
                        created: Math.floor(Date.now() / 1000), // Current timestamp.
                        model: strippedPayload.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: upstreamResponse.completion_message.role,
                                    content: upstreamResponse.completion_message.content
                                },
                                finish_reason: upstreamResponse.completion_message.stop_reason || "stop" // Default stop reason.
                            }
                        ],
                        usage: upstreamResponse.usage || {} // Optional usage statistics.
                    };

                    r.error(`Transformed OpenAI Response: ${JSON.stringify(openaiResponse)}`); // Log final response.
                    r.return(200, JSON.stringify(openaiResponse));
                } catch (e) {
                    // Catch and log transformation errors.
                    r.error(`Transformation failed: ${e.message}`);
                    r.return(500, "Internal Server Error: Transformation failure");
                }
            }
        );
    } catch (e) {
        // Handle errors in parsing the initial request.
        r.error(`Failed to parse request body: ${e.message}`);
        r.return(400, "Bad Request: Invalid JSON in request body");
    }
}

// Export the transformation functions for use in the NGINX JS module.
export default { transform_models, transform_chat_completion };
