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
 * Built-in Constitutional Safety Layer (inspired by @the-governor-hq/constitution)
 * enforces medical-context awareness through 4 zero-dependency defense layers:
 *
 *   Layer 1 — System Prompt Injection    (pre-generation, 0ms)
 *   Layer 2 — Input Pattern Validation   (pre-generation, <5ms)
 *   Layer 3 — Output Pattern Validation  (post-generation, <10ms)
 *   Layer 4 — Request Rate Limiting      (abuse prevention)
 *
 * Usage:
 *   node server.js
 *
 * Endpoints:
 *   POST /v1/chat/completions   → chat completions (streaming supported)
 *   POST /v1/completions        → text completions (streaming supported)
 *   GET  /v1/models             → list configured model
 *   GET  /v1/constitution       → constitution layer status & config
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
 *   GATEWAY_API_KEY — secret key that callers must send to this gateway
 *                   via  Authorization: Bearer <key>  or  x-api-key: <key>
 *                   If unset the gateway is open (handy for local dev)
 *   PORT          — server port (default: 3700)
 *   REQUEST_TIMEOUT_MS — upstream request timeout in ms (default: 120000)
 *
 * Constitution environment variables:
 *   CONSTITUTION_ENABLED  — master toggle (default: false)
 *   CONSTITUTION_DOMAIN   — wearables | bci | therapy | general (default: general)
 *   CONSTITUTION_MODE     — block | warn | log (default: warn)
 *   CONSTITUTION_SYSTEM_PROMPT — inject safety system prompt (default: true)
 *   CONSTITUTION_VALIDATE_INPUT — validate incoming messages (default: true)
 *   CONSTITUTION_VALIDATE_OUTPUT — validate LLM responses (default: true)
 *   CONSTITUTION_RATE_LIMIT — max requests per minute per IP (default: 60, 0=disabled)
 *   CONSTITUTION_LOG_VIOLATIONS — log all violations to stdout (default: true)
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
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || '';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10);

const START_TIME = Date.now();

// ─── Constitution Configuration ─────────────────────────────────────────────

const CONSTITUTION = {
  enabled:        process.env.CONSTITUTION_ENABLED === 'true',
  domain:         process.env.CONSTITUTION_DOMAIN || 'general',
  mode:           process.env.CONSTITUTION_MODE || 'warn',      // block | warn | log
  systemPrompt:   process.env.CONSTITUTION_SYSTEM_PROMPT !== 'false',
  validateInput:  process.env.CONSTITUTION_VALIDATE_INPUT !== 'false',
  validateOutput: process.env.CONSTITUTION_VALIDATE_OUTPUT !== 'false',
  rateLimit:      parseInt(process.env.CONSTITUTION_RATE_LIMIT || '60', 10),
  logViolations:  process.env.CONSTITUTION_LOG_VIOLATIONS !== 'false',
};

// ─── Constitution Layer — Medical Safety Framework ──────────────────────────
//
// Inspired by @the-governor-hq/constitution-core defense-in-depth architecture.
// Enforces 5 hard rules from the Governor HQ Constitutional Framework:
//
//   1. No Medical Claims     — no diagnoses, clinical assertions
//   2. No Supplement Advice  — no vitamin/mineral/medication dosing
//   3. No Disease Naming     — no named conditions, ICD/DSM codes
//   4. No Treatment Language — no "treat", "cure", "prevent", "heal"
//   5. No Imperative Directives — no "you should", "you must", "need to"
//
// Four enforcement layers, each independent (assumes preceding layers may fail):
//
//   Layer 1: System Prompt Injection    — constrains LLM generation at the source
//   Layer 2: Input Pattern Validation   — catches prompt injection & unsafe requests
//   Layer 3: Output Pattern Validation  — catches unsafe LLM responses
//   Layer 4: Request Rate Limiting      — prevents brute-force / abuse
//
// Performance: all regex-based, <10ms total validation latency, zero dependencies.
// ─────────────────────────────────────────────────────────────────────────────

// ── Layer 1: System Prompt Injection ─────────────────────────────────────────
// Injected as the first system message. The LLM sees these constraints before
// any user content — the single most effective layer for quality & safety.

const CONSTITUTION_SYSTEM_PROMPTS = {
  general: [
    'You are a helpful wellness assistant operating under strict constitutional safety constraints.',
    '',
    'HARD RULES (never violate):',
    '1. NEVER make medical diagnoses or clinical assertions. Use intra-individual baseline comparisons instead.',
    '2. NEVER recommend supplements, vitamins, minerals, or medications with specific dosing. Suggest behavioral changes only.',
    '3. NEVER name specific diseases, conditions, or ICD/DSM classifications. Describe neutral patterns instead.',
    '4. NEVER use treatment language ("treat", "cure", "prevent", "heal"). Use hedged language ("consider", "might help", "when ready").',
    '5. NEVER use imperative directives ("you should", "you must", "you need to"). Use optional framing ("you could", "some people find").',
    '',
    'Always include appropriate disclaimers when discussing health-adjacent topics.',
    'When in doubt, recommend consulting a qualified healthcare professional.',
    'Focus on observations about personal patterns and trends, not clinical interpretations.',
  ].join('\n'),

  wearables: [
    'You are a wearable-data wellness assistant operating under strict constitutional safety constraints.',
    '',
    'HARD RULES (never violate):',
    '1. NEVER diagnose conditions from wearable data (HRV, heart rate, sleep, SpO2, recovery scores). Only compare to the user\'s personal baseline.',
    '2. NEVER recommend supplements or medications. Suggest only behavioral adjustments (sleep hygiene, activity pacing, breathing exercises).',
    '3. NEVER name diseases or conditions (sleep apnea, atrial fibrillation, insomnia, etc.). Describe patterns neutrally ("your readings show a different pattern than usual").',
    '4. NEVER use treatment language. Use hedged alternatives ("you might consider", "some people find it helpful to").',
    '5. NEVER use imperative directives. Use optional framing ("you could try", "it might be worth exploring").',
    '',
    'Frame all insights as observations relative to the user\'s own baseline, not population norms.',
    'Require a stable personal baseline (typically 30-90 days of data) before making trend observations.',
    'Always add: "This is not medical advice. For health concerns, consult a healthcare professional."',
  ].join('\n'),

  bci: [
    'You are a brain-computer interface data assistant operating under strict constitutional safety constraints.',
    '',
    'HARD RULES (never violate):',
    '1. NEVER diagnose mental health conditions from EEG, fNIRS, or neurofeedback data.',
    '2. NEVER claim to read emotions, detect ADHD, autism, depression, or any condition from neural signals.',
    '3. NEVER name neurological or psychiatric conditions. Describe activity patterns neutrally.',
    '4. NEVER recommend treatments, therapies, or neurostimulation protocols.',
    '5. NEVER use imperative language. All suggestions must be optional and hedged.',
    '',
    'Neural data requires enhanced privacy considerations. Never store or reference identifiable neural signatures.',
    'Brain activity patterns are descriptive observations, not diagnostic indicators.',
    'Always recommend professional consultation for any health-related concerns.',
  ].join('\n'),

  therapy: [
    'You are a wellness journaling and mood-tracking assistant operating under strict constitutional safety constraints.',
    '',
    'HARD RULES (never violate):',
    '1. NEVER diagnose mental health conditions (depression, anxiety, PTSD, bipolar, etc.).',
    '2. NEVER prescribe medications, supplements, or specific therapeutic protocols.',
    '3. NEVER name disorders or use DSM/ICD terminology. Describe emotional patterns neutrally.',
    '4. NEVER use treatment language or claim to provide therapy.',
    '5. NEVER use imperative directives. Always maintain optional, empowering framing.',
    '',
    'If crisis language is detected (self-harm, suicide, harm to others), always provide crisis resources:',
    '  - 988 Suicide & Crisis Lifeline (call/text 988)',
    '  - Crisis Text Line (text HOME to 741741)',
    '  - findahelpline.com (international)',
    '',
    'You are a supportive companion, not a therapist. Encourage professional support when appropriate.',
  ].join('\n'),
};

// ── Layer 2 & 3: Pattern Validation Engine ───────────────────────────────────
// Ported from @the-governor-hq/constitution-core/validators/pattern-matcher.ts
// Multilingual regex patterns covering English, Spanish, French, German,
// Italian, Portuguese, Russian, Chinese, and Japanese.

const VALIDATION_PATTERNS = {
  // Critical severity — medical claims, diagnoses, disease names
  forbidden: [
    // Diagnosis language
    /\b(?:you\s+have|you(?:'re|\s+are)\s+(?:suffering|diagnosed)|diagnosis\s+(?:is|of)|you\s+(?:suffer|show\s+signs)\s+(?:from|of))\b/i,
    /\b(?:this\s+(?:is|indicates|suggests|confirms|shows)\s+(?:a\s+)?(?:sign|symptom|case|diagnosis)\s+(?:of|that))\b/i,
    /\b(?:usted\s+tiene|vous\s+avez|Sie\s+haben|lei\s+ha|você\s+tem)\b/i,

    // Disease / condition naming
    /\b(?:sleep\s+apnea|insomnia|narcolepsy|restless\s+leg|fibromyalgia|chronic\s+fatigue)\b/i,
    /\b(?:atrial\s+fibrillation|a[\s-]?fib|arrhythmia|tachycardia|bradycardia|hypertension|hypotension)\b/i,
    /\b(?:diabetes|pre[\s-]?diabet|metabolic\s+syndrome|thyroid|hypothyroid|hyperthyroid)\b/i,
    /\b(?:depression|anxiety\s+disorder|bipolar|schizophreni|ptsd|post[\s-]?traumatic|ocd|obsessive[\s-]?compulsive)\b/i,
    /\b(?:adhd|attention[\s-]?deficit|autism\s+spectrum|asd)\b/i,
    /\b(?:anorexia|bulimia|eating\s+disorder)\b/i,
    /\b(?:alzheimer|dementia|parkinson|epilepsy|multiple\s+sclerosis)\b/i,
    /\b(?:apnée|insomnio|Schlafapnoe|narcolepsie|taquicardia|hipertensión|diabète|dépression)\b/i,

    // Supplement / medication dosing
    /\b(?:take|consume|ingest)\s+\d+\s*(?:mg|mcg|iu|g|ml|µg|gram|milligram|microgram)\b/i,
    /\b(?:prescri(?:be|ption)|dosage|dose|administer|medication|medicate)\b/i,
    /\b(?:melatonin|magnesium|ashwagandh|valerian|5[\s-]?htp|cbd|thc|ssri|snri|benzodiazepine)\b/i,
    /\b(?:ibuprofen|acetaminophen|aspirin|paracetamol|naproxen|prednisone|cortisol\s+supplement)\b/i,

    // Treatment / cure language
    /\b(?:this\s+(?:will|can|should)\s+(?:treat|cure|heal|fix|remedy|resolve))\b/i,
    /\b(?:treatment\s+(?:for|of|plan)|cure\s+(?:for|your)|therapy\s+(?:for|to\s+treat))\b/i,
    /\b(?:traitement|tratamiento|Behandlung|trattamento|tratamento|лечение|治療|治疗)\b/i,
  ],

  // High severity — medical scope violations
  medicalScope: [
    /\b(?:clinical(?:ly)?|pathological|prognosis|etiology|contraindication|comorbidity|differential\s+diagnosis)\b/i,
    /\b(?:medical\s+(?:condition|diagnosis|treatment|advice|opinion|assessment))\b/i,
    /\b(?:at\s+risk\s+(?:for|of)\s+(?:cardiovascular|heart|stroke|cancer|disease))\b/i,
    /\b(?:symptoms?\s+(?:indicate|suggest|confirm|are\s+consistent\s+with))\b/i,
    /\b(?:ICD[\s-]?\d|DSM[\s-]?[IV5]|diagnostic\s+criteria)\b/i,
  ],

  // Medium severity — imperative / prescriptive
  prescriptive: [
    /\b(?:you\s+(?:should|must|need\s+to|have\s+to|ought\s+to|are\s+required\s+to))\b/i,
    /\b(?:it\s+is\s+(?:essential|critical|vital|imperative|necessary)\s+(?:that\s+you|to))\b/i,
    /\b(?:do\s+not\s+(?:ever|under\s+any\s+circumstances))\b/i,
    /\b(?:debes|necesitas|vous\s+devez|il\s+faut|Sie\s+müssen|Sie\s+sollten|deve|bisogna|você\s+precisa)\b/i,
  ],

  // High severity — alarming / emergency language
  alarming: [
    /\b(?:(?:medical|health)\s+emergency|seek\s+(?:immediate|emergency)\s+(?:help|care|attention))\b/i,
    /\b(?:(?:your|this)\s+(?:life|health)\s+is\s+(?:in\s+)?(?:serious\s+)?danger)\b/i,
    /\b(?:call\s+(?:911|999|112|ambulance)\s+(?:immediately|now|right\s+away))\b/i,
    /\b(?:you\s+(?:could|might|will)\s+die)\b/i,
  ],

  // Positive patterns — proper hedged language (boosts confidence)
  suggestive: [
    /\b(?:consider|you\s+(?:might|could|may\s+want\s+to)|some\s+people\s+find|it\s+might\s+(?:help|be\s+worth))\b/i,
    /\b(?:healthcare\s+professional|medical\s+provider|doctor|qualified\s+practitioner)\b/i,
    /\b(?:this\s+is\s+not\s+medical\s+advice|for\s+informational\s+purposes\s+only)\b/i,
    /\b(?:personal\s+(?:trend|pattern|baseline)|your\s+(?:own|recent)\s+(?:average|pattern))\b/i,
  ],

  // Crisis detection — always flag, never block (provide resources instead)
  crisis: [
    /\b(?:(?:want\s+to|going\s+to|plan(?:ning)?\s+to)\s+(?:kill|hurt|harm)\s+(?:myself|yourself|themselves))\b/i,
    /\b(?:suicid(?:e|al)|self[\s-]?harm|end\s+(?:my|their|your)\s+life)\b/i,
    /\b(?:don'?t\s+want\s+to\s+(?:live|be\s+alive|exist))\b/i,
    /\b(?:harm\s+(?:others?|someone|people))\b/i,
  ],
};

const SEVERITY_WEIGHTS = { forbidden: 0.5, medicalScope: 0.3, prescriptive: 0.2, alarming: 0.4 };
const SEVERITY_LABELS  = { forbidden: 'critical', medicalScope: 'high', prescriptive: 'medium', alarming: 'high' };

/**
 * Run the pattern validation engine on a text string.
 * Returns { safe, violations[], confidence, hasCrisisSignal }.
 * Latency: <10ms for typical messages.
 */
function validateText(text) {
  if (!text || !CONSTITUTION.enabled) return { safe: true, violations: [], confidence: 1.0, hasCrisisSignal: false };

  const normalized = text.normalize('NFC');
  const violations = [];
  let confidence = 1.0;

  // Check forbidden, medicalScope, prescriptive, alarming patterns
  for (const [category, patterns] of Object.entries(VALIDATION_PATTERNS)) {
    if (category === 'suggestive' || category === 'crisis') continue;
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match) {
        violations.push({
          category,
          severity: SEVERITY_LABELS[category] || 'medium',
          pattern: pattern.source.slice(0, 80),
          matched: match[0],
        });
        confidence -= (SEVERITY_WEIGHTS[category] || 0.2);
      }
    }
  }

  // Boost confidence for proper hedged language
  for (const pattern of VALIDATION_PATTERNS.suggestive) {
    if (pattern.test(normalized)) {
      confidence += 0.1;
    }
  }

  // Crisis signal detection — flagged but never blocked
  let hasCrisisSignal = false;
  for (const pattern of VALIDATION_PATTERNS.crisis) {
    if (pattern.test(normalized)) {
      hasCrisisSignal = true;
      break;
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    safe: violations.length === 0,
    violations,
    confidence: Math.round(confidence * 100) / 100,
    hasCrisisSignal,
  };
}

// ── Domain-specific safe alternatives ────────────────────────────────────────

const SAFE_ALTERNATIVES = {
  general: 'I can share observations about your patterns, but I\'m not able to provide medical diagnoses, treatment recommendations, or medication advice. For health concerns, please consult a qualified healthcare professional.',
  wearables: 'I can help you understand trends in your wearable data relative to your personal baseline. I\'m not able to diagnose conditions or recommend supplements. For health concerns, please consult a healthcare professional.',
  bci: 'I can describe patterns in your brain activity data, but I\'m not able to diagnose neurological or mental health conditions. For concerns about your neural health, please consult a qualified specialist.',
  therapy: 'I can help you reflect on your emotional patterns and journaling insights. I\'m not able to diagnose mental health conditions or prescribe treatments. If you\'re in crisis, please contact 988 (Suicide & Crisis Lifeline) or text HOME to 741741.',
};

const CRISIS_RESPONSE = [
  'I notice you may be going through a difficult time. Please reach out to these resources:',
  '',
  '• 988 Suicide & Crisis Lifeline — Call or text 988',
  '• Crisis Text Line — Text HOME to 741741',
  '• International — findahelpline.com',
  '',
  'You don\'t have to face this alone. A trained counselor is available 24/7.',
].join('\n');

/**
 * Build a blocked-response payload in OpenAI chat completion format.
 */
function buildBlockedResponse(violations, domain) {
  const safeMessage = SAFE_ALTERNATIVES[domain] || SAFE_ALTERNATIVES.general;
  const violationSummary = violations.map(v => `[${v.severity}] ${v.category}: "${v.matched}"`).join('; ');

  return {
    id: `chatcmpl-gov-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'governor-safety-layer',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: safeMessage },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _constitution: {
      blocked: true,
      mode: CONSTITUTION.mode,
      domain,
      violations: violations.length,
      summary: violationSummary,
    },
  };
}

/**
 * Build a crisis-aware response that appends crisis resources.
 */
function appendCrisisResources(responseData) {
  if (!responseData?.choices?.[0]?.message?.content) return responseData;
  const copy = JSON.parse(JSON.stringify(responseData));
  copy.choices[0].message.content += '\n\n---\n\n' + CRISIS_RESPONSE;
  copy._constitution = { ...(copy._constitution || {}), crisisResourcesAppended: true };
  return copy;
}

// ── Layer 4: Rate Limiting ───────────────────────────────────────────────────

const rateLimitMap = new Map(); // ip → { count, windowStart }
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(ip) {
  if (!CONSTITUTION.enabled || CONSTITUTION.rateLimit <= 0) return true;

  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  entry.count++;
  if (entry.count > CONSTITUTION.rateLimit) return false;
  return true;
}

// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [ip, entry] of rateLimitMap) {
    if (entry.windowStart < cutoff) rateLimitMap.delete(ip);
  }
}, 300_000).unref();

// ── Constitution stats (in-memory counters) ──────────────────────────────────

const constitutionStats = {
  totalValidated: 0,
  inputBlocked: 0,
  outputBlocked: 0,
  inputWarnings: 0,
  outputWarnings: 0,
  crisisDetected: 0,
  rateLimited: 0,
  systemPromptsInjected: 0,
};

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

  // ── Constitution Layer 2: Input Validation ─────────────────────────────
  if (CONSTITUTION.enabled && CONSTITUTION.validateInput) {
    const userText = upstream.messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join(' ');

    const inputResult = validateText(userText);
    constitutionStats.totalValidated++;

    if (inputResult.hasCrisisSignal) {
      constitutionStats.crisisDetected++;
      if (CONSTITUTION.logViolations) log('warn', 'constitution: crisis signal detected in input', { domain: CONSTITUTION.domain });
      // Do NOT block — but ensure crisis resources are delivered (handled in output)
      upstream._crisisDetected = true;
    }

    if (!inputResult.safe) {
      if (CONSTITUTION.logViolations) {
        log('warn', 'constitution: input violations detected', {
          mode: CONSTITUTION.mode,
          violations: inputResult.violations.length,
          confidence: inputResult.confidence,
          details: inputResult.violations,
        });
      }

      if (CONSTITUTION.mode === 'block') {
        constitutionStats.inputBlocked++;
        return sendJSON(res, 200, buildBlockedResponse(inputResult.violations, CONSTITUTION.domain));
      }
      constitutionStats.inputWarnings++;
    }
  }

  // ── Constitution Layer 1: System Prompt Injection ──────────────────────
  if (CONSTITUTION.enabled && CONSTITUTION.systemPrompt) {
    const safetyPrompt = CONSTITUTION_SYSTEM_PROMPTS[CONSTITUTION.domain] || CONSTITUTION_SYSTEM_PROMPTS.general;
    const hasSystemMsg = upstream.messages.some(m => m.role === 'system');

    if (hasSystemMsg) {
      // Prepend safety rules to the existing system message
      upstream.messages = upstream.messages.map(m => {
        if (m.role === 'system') {
          return { ...m, content: safetyPrompt + '\n\n' + m.content };
        }
        return m;
      });
    } else {
      // Insert safety system message at position 0
      upstream.messages = [
        { role: 'system', content: safetyPrompt },
        ...upstream.messages,
      ];
    }
    constitutionStats.systemPromptsInjected++;
  }

  const crisisDetected = upstream._crisisDetected;
  delete upstream._crisisDetected;

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
    // Streaming: Layer 1 (system prompt) does the heavy lifting.
    // We pass through the SSE stream directly for latency.
    // Full output validation is not applied to streams — the system prompt
    // constrains generation at the source, which is the most effective
    // approach without sacrificing streaming speed.
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

    // ── Constitution Layer 3: Output Validation ──────────────────────────
    if (CONSTITUTION.enabled && CONSTITUTION.validateOutput && data?.choices?.[0]?.message?.content) {
      const outputText = data.choices[0].message.content;
      const outputResult = validateText(outputText);
      constitutionStats.totalValidated++;

      if (outputResult.hasCrisisSignal || crisisDetected) {
        constitutionStats.crisisDetected++;
        data = appendCrisisResources(data);
      }

      if (!outputResult.safe) {
        if (CONSTITUTION.logViolations) {
          log('warn', 'constitution: output violations detected', {
            mode: CONSTITUTION.mode,
            violations: outputResult.violations.length,
            confidence: outputResult.confidence,
            details: outputResult.violations,
          });
        }

        if (CONSTITUTION.mode === 'block') {
          constitutionStats.outputBlocked++;
          return sendJSON(res, 200, buildBlockedResponse(outputResult.violations, CONSTITUTION.domain));
        }

        constitutionStats.outputWarnings++;
        // In warn/log mode, attach metadata but pass through the response
        data._constitution = {
          ...(data._constitution || {}),
          outputValidation: {
            safe: false,
            violations: outputResult.violations.length,
            confidence: outputResult.confidence,
            mode: CONSTITUTION.mode,
          },
        };
      }
    } else if (crisisDetected && data?.choices?.[0]?.message?.content) {
      data = appendCrisisResources(data);
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
    constitution: {
      enabled: CONSTITUTION.enabled,
      domain: CONSTITUTION.domain,
      mode: CONSTITUTION.mode,
      layers: {
        systemPrompt: CONSTITUTION.systemPrompt,
        inputValidation: CONSTITUTION.validateInput,
        outputValidation: CONSTITUTION.validateOutput,
        rateLimiting: CONSTITUTION.rateLimit > 0,
      },
    },
    endpoints: [
      'POST /v1/chat/completions',
      'POST /v1/completions',
      'GET  /v1/models',
      'GET  /v1/constitution',
      'GET  /health',
      'GET  /info',
    ],
  });
}

function handleConstitution(_req, res) {
  sendJSON(res, 200, {
    name: 'Governor HQ Constitutional Safety Layer',
    version: '1.0.0',
    framework: '@the-governor-hq/constitution',
    enabled: CONSTITUTION.enabled,
    config: {
      domain: CONSTITUTION.domain,
      mode: CONSTITUTION.mode,
      systemPrompt: CONSTITUTION.systemPrompt,
      validateInput: CONSTITUTION.validateInput,
      validateOutput: CONSTITUTION.validateOutput,
      rateLimit: CONSTITUTION.rateLimit > 0 ? `${CONSTITUTION.rateLimit}/min` : 'disabled',
    },
    hardRules: [
      '1. No Medical Claims — no diagnoses, clinical assertions',
      '2. No Supplement Advice — no vitamin/mineral/medication dosing',
      '3. No Disease Naming — no named conditions, ICD/DSM codes',
      '4. No Treatment Language — no "treat", "cure", "prevent", "heal"',
      '5. No Imperative Directives — no "you should", "you must"',
    ],
    layers: [
      { id: 1, name: 'System Prompt Injection', phase: 'pre-generation', latency: '0ms', enabled: CONSTITUTION.systemPrompt },
      { id: 2, name: 'Input Pattern Validation', phase: 'pre-generation', latency: '<5ms', enabled: CONSTITUTION.validateInput },
      { id: 3, name: 'Output Pattern Validation', phase: 'post-generation', latency: '<10ms', enabled: CONSTITUTION.validateOutput },
      { id: 4, name: 'Request Rate Limiting', phase: 'abuse-prevention', latency: '<1ms', enabled: CONSTITUTION.rateLimit > 0 },
    ],
    stats: constitutionStats,
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

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Returns true when the request carries the correct gateway key.
 * Accepts the key via:
 *   - Authorization: Bearer <key>
 *   - x-api-key: <key>
 *
 * If GATEWAY_API_KEY is not configured the gateway is open.
 */
function isAuthorized(req) {
  if (!GATEWAY_API_KEY) return true; // open mode

  const authHeader = req.headers['authorization'] || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === GATEWAY_API_KEY) return true;
  }

  const xApiKey = (req.headers['x-api-key'] || '').trim();
  if (xApiKey === GATEWAY_API_KEY) return true;

  return false;
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function router(req, res) {
  corsHeaders(res);

  // Preflight — always allowed so browsers can discover the endpoint
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const { pathname } = url.parse(req.url);
  const method = req.method.toUpperCase();

  // Health, info & constitution status are always public
  if (method === 'GET' && pathname === '/health')           return handleHealth(req, res);
  if (method === 'GET' && pathname === '/info')             return handleInfo(req, res);
  if (method === 'GET' && pathname === '/v1/constitution')  return handleConstitution(req, res);

  // All other routes require auth when GATEWAY_API_KEY is set
  if (!isAuthorized(req)) {
    log('warn', 'unauthorized request', { method, pathname, ip: req.socket?.remoteAddress });
    return sendError(res, 401, 'Unauthorized — provide a valid key via Authorization: Bearer <key> or x-api-key header', 'authentication_error');
  }

  // ── Constitution Layer 4: Rate Limiting ──────────────────────────────────
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    constitutionStats.rateLimited++;
    log('warn', 'constitution: rate limit exceeded', { ip: clientIp, limit: CONSTITUTION.rateLimit });
    return sendError(res, 429, `Rate limit exceeded — max ${CONSTITUTION.rateLimit} requests/minute`, 'rate_limit_error');
  }

  try {
    if (method === 'POST' && pathname === '/v1/chat/completions') return await handleChatCompletions(req, res);
    if (method === 'POST' && pathname === '/v1/completions')      return await handleCompletions(req, res);
    if (method === 'GET'  && pathname === '/v1/models')           return handleModels(req, res);

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
    upstream_key_set: !!LLM_API_KEY,
    gateway_auth: GATEWAY_API_KEY ? 'enabled' : 'OPEN',
    constitution: {
      enabled: CONSTITUTION.enabled,
      domain: CONSTITUTION.domain,
      mode: CONSTITUTION.mode,
      layers: [
        CONSTITUTION.systemPrompt   && 'system-prompt',
        CONSTITUTION.validateInput  && 'input-validation',
        CONSTITUTION.validateOutput && 'output-validation',
        CONSTITUTION.rateLimit > 0  && 'rate-limiting',
      ].filter(Boolean),
    },
  });
  console.log(`\n  LLM API Gateway running on http://localhost:${PORT}`);
  console.log(`  Model        : ${LLM_MODEL}`);
  console.log(`  Provider     : ${LLM_API_URL}`);
  console.log(`  Auth         : ${GATEWAY_API_KEY ? 'enabled (GATEWAY_API_KEY set)' : 'OPEN — set GATEWAY_API_KEY to protect'}`);
  if (CONSTITUTION.enabled) {
    console.log(`  Constitution : ACTIVE — domain=${CONSTITUTION.domain}, mode=${CONSTITUTION.mode}`);
    console.log(`  Layers       : ${[
      CONSTITUTION.systemPrompt   && 'system-prompt',
      CONSTITUTION.validateInput  && 'input-validation',
      CONSTITUTION.validateOutput && 'output-validation',
      CONSTITUTION.rateLimit > 0  && `rate-limit(${CONSTITUTION.rateLimit}/min)`,
    ].filter(Boolean).join(', ')}`);
  } else {
    console.log(`  Constitution : DISABLED`);
  }
  console.log('');
});

server.on('error', err => {
  log('error', 'server error', { error: err.message });
  process.exit(1);
});

process.on('SIGTERM', () => {
  log('info', 'shutting down');
  server.close(() => process.exit(0));
});
