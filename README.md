# llama-stack-bridge

Bridges Meta's Llama Stack serve endpoint via Nginx JS transform to expose an OpenAI-compatible endpoint.

## Overview

This project provides a bridge between Meta's Llama Stack serve endpoint and an OpenAI-compatible API. It uses Nginx with JavaScript transformations to adapt requests and responses between the two APIs.

## Features

- **Configurable Upstream Host and Port**: Easily set the upstream Llama Stack host and port using a `.env` file.
- **Transformation Logic**: Converts Llama Stack responses to match OpenAI API specifications.
- **Dockerized Deployment**: Simplifies deployment using Docker and Docker Compose.

## Prerequisites

- **Docker** and **Docker Compose** installed on your system.
- An instance of **Llama Stack** running and accessible.

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/matthewhand/llama-stack-bridge.git
cd llama-stack-bridge
```

### 2. Configure Environment Variables

Copy the `.env.sample` file to `.env` and modify it according to your setup.

```bash
cp .env.sample .env
```

Edit the `.env` file to set the upstream Llama Stack host and port:

```dotenv
UPSTREAM_HOST=host.docker.internal
UPSTREAM_PORT=42069
```

- **UPSTREAM_HOST**: The hostname or IP address where your Llama Stack is running.
- **UPSTREAM_PORT**: The port on which your Llama Stack is listening.

### 3. Run the Bridge

Start the Nginx bridge using Docker Compose:

```bash
docker-compose up -d
```

This command builds the Docker image and starts the Nginx container.

### 4. Verify the Setup

You can test the bridge by sending a request to the OpenAI-compatible endpoint exposed by the bridge:

```bash
curl http://localhost:42070/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "Hello, world!"}]
  }'
```

## Running Llama Stack

The bridge expects a Llama Stack instance running and accessible at the host and port specified in your `.env` file.

### Starting Llama Stack

To run Llama Stack, you can use the following command (adjust as necessary):

```bash
llama stack run llamastack --port 42069
```

This command launches Llama Stack with the profile `llamastack` on port `42069`.

### Llama Stack Configuration

For more information on setting up and running Llama Stack, refer to the official documentation:

- [Llama Stack Getting Started Guide](https://github.com/meta-llama/llama-stack/blob/main/docs/getting_started.md)

**Note:** Setting up Llama Stack is outside the scope of this project.

## Project Structure

- `nginx/`
  - `nginx.conf`: Nginx configuration file.
  - `transform.js`: JavaScript file containing transformation logic.
  - `Dockerfile`: Dockerfile for building the Nginx image.
  - `cache/`: Directory for Nginx cache.
  - `logs/`: Directory for Nginx logs.
- `docker-compose.yaml`: Docker Compose file for the bridge.
- `.env.sample`: Sample environment variables file.
- `.gitignore`: Git ignore file.
- `README.md`: Project documentation.
- `LICENSE`: License information.

## TODO

- [x] Fix `stop_reason` bug
- [ ] Streaming

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

