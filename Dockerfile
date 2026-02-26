FROM node:22-alpine

LABEL name="llm-api" \
      description="Universal LLM proxy gateway" \
      version="1.0.0"

WORKDIR /app

COPY server.js .
COPY package.json .

# ── Upstream LLM configuration ──────────────────────────────────────────────
# Override these at runtime via environment variables or fly secrets.
# LLM_API_KEY must always be set as a secret — never bake it into the image.
ENV PORT=3700 \
    LLM_API_URL=https://api.openai.com/v1 \
    LLM_MODEL=gpt-4o-mini \
    REQUEST_TIMEOUT_MS=120000

EXPOSE 3700

USER node

CMD ["node", "server.js"]
