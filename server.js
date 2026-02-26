/**
 * ============================================================================
 * LLM API — Universal LLM Proxy Gateway
 * Part of The Governor HQ Suite
 * ============================================================================
 *
 * Single-file Node.js server. Zero dependencies.
 *
 * Acts as an OpenAI-compatible proxy in front of any LLM provider.
 * External apps configure just the gateway URL — the actual model,
 * provider API URL and key are kept server-side as env vars.
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /v1/chat/completions   → chat completions (streaming supported)
 *   POST /v1/completions        → text completions (streaming supported)
 *   GET  /v1/models             → list configured model
 *   GET  /health                → health check
 *   GET  /info                  → public server info (no secrets)
 *
 * Environment variables:
 *   LLM_API_URL   — base URL of the upstream LLM provider
 *                   (default: https://api.openai.com/v1)
 *                   Examples:
 *                     https://api.openai.com/v1
 *                     https://api.anthropic.com/v1
 *                     https://generativelanguage.googleapis.com/v1beta/openai
 *                     http://localhost:11434/v1   (Ollama)
 *   LLM_MODEL     — model identifier to use
 *                   (default: gpt-4o-mini)
 *   LLM_API_KEY   — API key for the upstream provider
 *                   (required for hosted providers)
 *   PORT          — server port (default: 3700)
 *   REQUEST_TIMEOUT_MS — upstream request timeout in ms (default: 120000)
 * ============================================================================
 */

'use strict';

const http = require('http');
const https = require('https');
const url = require('url');

// ─── Configuration ──────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT || '3700', 10);
const LLM_API_URL     = (process.env.LLM_API_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const LLM_MODEL       = process.env.LLM_MODEL || 'gpt-4o-mini';
const LLM_API_KEY     = process.env.LLM_API_KEY || '';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);

const START_TIME = Date.now();

// ─── Utilities ───────────────────────────────────────────────────────────────

function log(level, msg, data) {
  const entry = { ts: new Date().toISOString(), level, msg };
  if (data) entry.data = data;
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, status, message, type = 'server_error') {
  sendJSON(res, status, {
    error: { message, type, code: status },
  });
}

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ─── Upstream request helper ─────────────────────────────────────────────────

/**
 * Make a request to the upstream LLM API.
 * Returns the raw IncomingMessage so callers can stream if needed.
 */
function upstreamRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const targetUrl = `${LLM_API_URL}${endpoint}`;
    const parsed = new url.URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const payload = JSON.stringify(body);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
      },
      timeout: REQUEST_TIMEOUT,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, resolve);

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Upstream request timed out after ${REQUEST_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Read a full upstream response as a parsed JSON object.
 */
function readUpstreamJSON(upstreamRes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    upstreamRes.on('data', c => chunks.push(c));
    upstreamRes.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Upstream returned non-JSON response'));
      }
    });
    upstreamRes.on('error', reject);
  });
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return sendError(res, 400, 'Invalid JSON body', 'invalid_request_error');
  }

  // Inject server-side model if caller did not specify one
  const upstream = {
    model: LLM_MODEL,
    ...body,
    // Always enforce server model — comment out the line above to let callers override
    model: body.model || LLM_MODEL,
  };

  if (!upstream.messages || !Array.isArray(upstream.messages)) {
    return sendError(res, 400, '"messages" array is required', 'invalid_request_error');
  }

  const isStreaming = upstream.stream === true;
  log('info', 'chat/completions', { model: upstream.model, stream: isStreaming, messages: upstream.messages.length });

  let upstreamRes;
  try {
    upstreamRes = await upstreamRequest('/chat/completions', upstream);
  } catch (err) {
    log('error', 'upstream request failed', { error: err.message });
    return sendError(res, 502, `Upstream error: ${err.message}`, 'api_error');
  }

  if (isStreaming) {
    // Pass through SSE stream directly
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });
    upstreamRes.pipe(res);
    upstreamRes.on('error', err => {
      log('error', 'stream error', { error: err.message });
      res.end();
    });
  } else {
    let data;
    try {
      data = await readUpstreamJSON(upstreamRes);
    } catch (err) {
      return sendError(res, 502, `Upstream parse error: ${err.message}`, 'api_error');
    }
    sendJSON(res, upstreamRes.statusCode, data);
  }
}

async function handleCompletions(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch {
    return sendError(res, 400, 'Invalid JSON body', 'invalid_request_error');
  }

  const upstream = {
    model: LLM_MODEL,
    ...body,
    model: body.model || LLM_MODEL,
  };

  if (!upstream.prompt) {
    return sendError(res, 400, '"prompt" is required', 'invalid_request_error');
  }

  const isStreaming = upstream.stream === true;
  log('info', 'completions', { model: upstream.model, stream: isStreaming });

  let upstreamRes;
  try {
    upstreamRes = await upstreamRequest('/completions', upstream);
  } catch (err) {
    log('error', 'upstream request failed', { error: err.message });
    return sendError(res, 502, `Upstream error: ${err.message}`, 'api_error');
  }

  if (isStreaming) {
    res.writeHead(upstreamRes.statusCode, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });
    upstreamRes.pipe(res);
  } else {
    let data;
    try {
      data = await readUpstreamJSON(upstreamRes);
    } catch (err) {
      return sendError(res, 502, `Upstream parse error: ${err.message}`, 'api_error');
    }
    sendJSON(res, upstreamRes.statusCode, data);
  }
}

function handleModels(_req, res) {
  const now = Math.floor(Date.now() / 1000);
  sendJSON(res, 200, {
    object: 'list',
    data: [
      {
        id: LLM_MODEL,
        object: 'model',
        created: now,
        owned_by: 'llm-api-proxy',
      },
    ],
  });
}

function handleHealth(_req, res) {
  const uptimeMs = Date.now() - START_TIME;
  sendJSON(res, 200, {
    status: 'ok',
    uptime_ms: uptimeMs,
    uptime_human: formatUptime(uptimeMs),
    timestamp: new Date().toISOString(),
  });
}

function handleInfo(_req, res) {
  sendJSON(res, 200, {
    name: 'llm-api',
    description: 'Universal LLM proxy gateway — Part of The Governor HQ Suite',
    model: LLM_MODEL,
    provider_url: LLM_API_URL,
    // key is never exposed
    endpoints: [
      'POST /v1/chat/completions',
      'POST /v1/completions',
      'GET  /v1/models',
      'GET  /health',
      'GET  /info',
    ],
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(req, res) {
  corsHeaders(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const { pathname } = url.parse(req.url);
  const method = req.method.toUpperCase();

  try {
    if (method === 'POST' && pathname === '/v1/chat/completions') return await handleChatCompletions(req, res);
    if (method === 'POST' && pathname === '/v1/completions')      return await handleCompletions(req, res);
    if (method === 'GET'  && pathname === '/v1/models')           return handleModels(req, res);
    if (method === 'GET'  && pathname === '/health')              return handleHealth(req, res);
    if (method === 'GET'  && pathname === '/info')                return handleInfo(req, res);

    sendError(res, 404, `Route not found: ${method} ${pathname}`, 'not_found');
  } catch (err) {
    log('error', 'unhandled route error', { error: err.message, stack: err.stack });
    sendError(res, 500, 'Internal server error', 'server_error');
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

const server = http.createServer(router);

server.listen(PORT, () => {
  log('info', 'llm-api started', {
    port: PORT,
    model: LLM_MODEL,
    provider: LLM_API_URL,
    key_set: !!LLM_API_KEY,
  });
  console.log(`\n  LLM API Gateway running on http://localhost:${PORT}`);
  console.log(`  Model   : ${LLM_MODEL}`);
  console.log(`  Provider: ${LLM_API_URL}`);
  console.log(`  Key set : ${LLM_API_KEY ? 'yes' : 'NO — set LLM_API_KEY'}\n`);
});

server.on('error', err => {
  log('error', 'server error', { error: err.message });
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('info', 'shutting down');
  server.close(() => process.exit(0));
});
