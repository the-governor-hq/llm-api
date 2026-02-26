# llm-api

> Universal LLM proxy gateway

Single-file, zero-dependency Node.js server that sits in front of any LLM provider and exposes an **OpenAI-compatible API**. External apps connect to this gateway and never need to know the actual provider, model, or key.

## How it works

```
Your app  →  POST /v1/chat/completions  →  llm-api  →  Any LLM provider
                                                         (OpenAI, Anthropic,
                                                          Gemini, Ollama, …)
```

Four env vars are all that's needed — three for the upstream provider, one to protect the gateway itself:

| Variable | Description | Default |
|---|---|---|
| `LLM_API_URL` | Base URL of the upstream LLM provider | `https://api.openai.com/v1` |
| `LLM_MODEL` | Model identifier | `gpt-4o-mini` |
| `LLM_API_KEY` | API key for the upstream provider | *(empty)* |
| `GATEWAY_API_KEY` | Secret key that callers must send to use the gateway | *(empty = open)* |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions — streaming supported |
| `POST` | `/v1/completions` | Text completions — streaming supported |
| `GET` | `/v1/models` | Returns the configured model |
| `GET` | `/health` | Health check + uptime |
| `GET` | `/info` | Public server info (no secrets exposed) |

## Security

Set `GATEWAY_API_KEY` to protect the gateway from unauthorized use. When set, all requests to `/v1/*` must include the key via:

```
Authorization: Bearer <your-gateway-key>
```
or
```
x-api-key: <your-gateway-key>
```

`/health` and `/info` are always public (no key needed).

If `GATEWAY_API_KEY` is not set the gateway is fully open — fine for local dev, not recommended in production.

## Quick start

```bash
# Clone / enter the directory
cd llm-api

# Run with OpenAI (open, no gateway auth)
LLM_API_KEY=sk-... node server.js

# Run with gateway auth enabled
GATEWAY_API_KEY=my-secret LLM_API_KEY=sk-... node server.js

# Run with Ollama (no key needed)
LLM_API_URL=http://localhost:11434/v1 LLM_MODEL=llama3 node server.js

# Run with Anthropic (OpenAI-compatible endpoint)
LLM_API_URL=https://api.anthropic.com/v1 LLM_MODEL=claude-3-5-sonnet-20241022 LLM_API_KEY=sk-ant-... node server.js
```

## Usage examples

### Chat completion

```bash
curl http://localhost:3700/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret" \
  -d '{
    "messages": [
      { "role": "user", "content": "Hello! What model are you?" }
    ]
  }'
```

### Streaming

```bash
curl http://localhost:3700/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Count to 10." }],
    "stream": true
  }'
```

### Use with OpenAI SDK

```js
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3700/v1',
  apiKey: 'my-secret',   // this is your GATEWAY_API_KEY, not the upstream key
});

const response = await client.chat.completions.create({
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

## Provider examples

| Provider | `LLM_API_URL` | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Anthropic | `https://api.anthropic.com/v1` | `claude-3-5-sonnet-20241022` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Together AI | `https://api.together.xyz/v1` | `meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3` |

## Docker

```bash
docker build -t llm-api .

docker run -p 3700:3700 \
  -e LLM_API_URL=https://api.openai.com/v1 \
  -e LLM_MODEL=gpt-4o-mini \
  -e LLM_API_KEY=sk-... \
  -e GATEWAY_API_KEY=my-secret \
  llm-api
```

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set LLM_API_KEY=sk-...
fly secrets set GATEWAY_API_KEY=my-secret
fly secrets set LLM_API_URL=https://api.openai.com/v1
fly secrets set LLM_MODEL=gpt-4o-mini
fly deploy
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3700` | Server port |
| `LLM_API_URL` | `https://api.openai.com/v1` | Upstream provider base URL |
| `LLM_MODEL` | `gpt-4o-mini` | Model to use |
| `LLM_API_KEY` | *(empty)* | Upstream provider API key |
| `GATEWAY_API_KEY` | *(empty)* | Gateway auth key — leave empty for open access |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout in milliseconds |
