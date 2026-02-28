# llm-api

> Universal LLM proxy gateway with built-in constitutional safety

Single-file, zero-dependency Node.js server that sits in front of any LLM provider and exposes an **OpenAI-compatible API**. External apps connect to this gateway and never need to know the actual provider, model, or key.

Includes an optional **Constitutional Safety Layer** — a medical-context-aware defense-in-depth system inspired by [`@the-governor-hq/constitution`](https://the-governor-hq.vercel.app) that enforces wellness boundaries without sacrificing latency.

## How it works

```
Your app  →  POST /v1/chat/completions  →  llm-api  →  Any LLM provider
                                             │          (OpenAI, Anthropic,
                                             │           Gemini, Ollama, …)
                                             │
                                      ┌──────┴──────┐
                                      │ Constitution │
                                      │    Layers    │
                                      └─────────────┘
                                      L1: System Prompt    (pre-gen,  0ms)
                                      L2: Input Validation (pre-gen, <5ms)
                                      L3: Output Validation(post-gen,<10ms)
                                      L4: Rate Limiting    (per-IP)
```

Four env vars for the proxy, plus one toggle to activate safety:

| Variable | Description | Default |
|---|---|---|
| `LLM_API_URL` | Base URL of the upstream LLM provider | `https://api.openai.com/v1` |
| `LLM_MODEL` | Model identifier | `gpt-4o-mini` |
| `LLM_API_KEY` | API key for the upstream provider | *(empty)* |
| `GATEWAY_API_KEY` | Secret key that callers must send to use the gateway | *(empty = open)* |
| `CONSTITUTION_ENABLED` | Activate the constitutional safety layer | `false` |

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions — streaming supported |
| `POST` | `/v1/completions` | Text completions — streaming supported |
| `GET` | `/v1/models` | Returns the configured model |
| `GET` | `/v1/constitution` | Constitution layer status, config & stats |
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

# Run with constitutional safety enabled (wearables domain, block mode)
CONSTITUTION_ENABLED=true CONSTITUTION_DOMAIN=wearables CONSTITUTION_MODE=block \
  LLM_API_KEY=sk-... node server.js

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

### Proxy

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3700` | Server port |
| `LLM_API_URL` | `https://api.openai.com/v1` | Upstream provider base URL |
| `LLM_MODEL` | `gpt-4o-mini` | Model to use |
| `LLM_API_KEY` | *(empty)* | Upstream provider API key |
| `GATEWAY_API_KEY` | *(empty)* | Gateway auth key — leave empty for open access |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout in milliseconds |

### Constitution

| Variable | Default | Description |
|---|---|---|
| `CONSTITUTION_ENABLED` | `false` | Master toggle — set to `true` to activate |
| `CONSTITUTION_DOMAIN` | `general` | Safety domain: `general`, `wearables`, `bci`, `therapy` |
| `CONSTITUTION_MODE` | `warn` | Violation handling: `block`, `warn`, `log` |
| `CONSTITUTION_SYSTEM_PROMPT` | `true` | Inject safety system prompt into every request |
| `CONSTITUTION_VALIDATE_INPUT` | `true` | Validate user messages before sending upstream |
| `CONSTITUTION_VALIDATE_OUTPUT` | `true` | Validate LLM responses before returning |
| `CONSTITUTION_RATE_LIMIT` | `60` | Max requests per minute per IP (0 = disabled) |
| `CONSTITUTION_LOG_VIOLATIONS` | `true` | Log all violations to stdout |

## Constitutional Safety Layer

Built-in, zero-dependency implementation inspired by the [`@the-governor-hq/constitution`](https://the-governor-hq.vercel.app) framework. Enforces **5 hard rules** at the proxy layer — no changes needed in your app:

| # | Rule | Prohibited | Safe Alternative |
|---|---|---|---|
| 1 | **No Medical Claims** | Diagnoses, clinical assertions | Baseline comparisons |
| 2 | **No Supplement Advice** | Vitamin/medication dosing | Behavioral suggestions |
| 3 | **No Disease Naming** | Named conditions, ICD/DSM codes | Neutral pattern descriptions |
| 4 | **No Treatment Language** | "treat", "cure", "prevent" | "consider", "might help" |
| 5 | **No Imperative Directives** | "you should", "you must" | "you could", "some find" |

### 4 Defense Layers

Each layer is independent — assumes the preceding layer may fail.

| Layer | Phase | Latency | What it does |
|---|---|---|---|
| **1. System Prompt** | Pre-generation | 0ms | Injects domain-specific safety rules as the first system message |
| **2. Input Validation** | Pre-generation | <5ms | Regex pattern matching on user messages — catches unsafe requests |
| **3. Output Validation** | Post-generation | <10ms | Regex pattern matching on LLM responses — catches unsafe outputs |
| **4. Rate Limiting** | Abuse prevention | <1ms | Per-IP sliding window, prevents brute-force abuse |

### Domains

| Domain | Use case |
|---|---|
| `general` | Default — general wellness assistant constraints |
| `wearables` | HRV, sleep, heart rate, SpO2, recovery — baseline-relative observations only |
| `bci` | EEG, fNIRS, neurofeedback — no neural diagnosis or emotion claims |
| `therapy` | Mood tracking, journaling — no mental health diagnoses, includes crisis resources |

### Modes

| Mode | Behavior |
|---|---|
| `block` | Unsafe content is replaced with a safe domain-appropriate alternative |
| `warn` | Violations logged, metadata attached to response via `_constitution` field, content passes through |
| `log` | Violations logged silently, content passes through unchanged |

### Crisis Detection

When crisis language is detected (self-harm, suicide), the system **never blocks** — instead it appends crisis resources to the response:

- **988 Suicide & Crisis Lifeline** — Call or text 988
- **Crisis Text Line** — Text HOME to 741741
- **International** — findahelpline.com

### Introspection

```bash
# Check constitution status and stats
curl http://localhost:3700/v1/constitution
```

Returns layer configuration, the 5 hard rules, and live violation counters.

### Example: Wearables in block mode

```bash
CONSTITUTION_ENABLED=true \
CONSTITUTION_DOMAIN=wearables \
CONSTITUTION_MODE=block \
LLM_API_KEY=sk-... \
  node server.js
```

If the LLM tries to say *"You have sleep apnea — take 5mg melatonin"*, the gateway intercepts it and returns:

> *"I can help you understand trends in your wearable data relative to your personal baseline. I'm not able to diagnose conditions or recommend supplements. For health concerns, please consult a healthcare professional."*
