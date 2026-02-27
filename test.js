/**
 * Test suite for LLM API Gateway
 * 
 * Run with: node test.js
 * 
 * Before running:
 *   1. Ensure server is running: node server.js
 *   2. Configure .env with valid credentials if testing real providers
 */

'use strict';

const http = require('http');

// Test configuration
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3700';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || '';

let passedTests = 0;
let failedTests = 0;

// ─── Test Utilities ──────────────────────────────────────────────────────────

function makeRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    
    const defaultHeaders = {
      'Content-Type': 'application/json',
    };
    
    if (GATEWAY_API_KEY) {
      defaultHeaders['Authorization'] = `Bearer ${GATEWAY_API_KEY}`;
    }
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { ...defaultHeaders, ...headers },
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    
    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    
    req.end();
  });
}

function assert(condition, testName) {
  if (condition) {
    console.log(`✅ PASS: ${testName}`);
    passedTests++;
  } else {
    console.log(`❌ FAIL: ${testName}`);
    failedTests++;
  }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

async function runTests() {
  console.log('🧪 Starting LLM API Gateway Test Suite\n');
  console.log(`Testing against: ${BASE_URL}\n`);
  
  try {
    // Test 1: Health check
    console.log('Test 1: Health check endpoint');
    const health = await makeRequest('GET', '/health');
    assert(health.status === 200, 'Health endpoint returns 200');
    assert(health.body.status === 'ok', 'Health status is "ok"');
    assert(typeof health.body.uptime === 'number', 'Uptime is a number');
    console.log();
    
    // Test 2: Server info
    console.log('Test 2: Server info endpoint');
    const info = await makeRequest('GET', '/info');
    assert(info.status === 200, 'Info endpoint returns 200');
    assert(info.body.name === '@the-governor-hq/llm-api', 'Correct server name');
    assert(typeof info.body.version === 'string', 'Version is present');
    assert(typeof info.body.uptime === 'number', 'Uptime is present');
    console.log();
    
    // Test 3: List models
    console.log('Test 3: List models endpoint');
    const models = await makeRequest('GET', '/v1/models');
    assert(models.status === 200, 'Models endpoint returns 200');
    assert(models.body.object === 'list', 'Response object type is "list"');
    assert(Array.isArray(models.body.data), 'Models data is an array');
    assert(models.body.data.length > 0, 'At least one model is listed');
    console.log();
    
    // Test 4: CORS headers
    console.log('Test 4: CORS headers');
    const cors = await makeRequest('OPTIONS', '/v1/models');
    assert(
      cors.headers['access-control-allow-origin'] === '*',
      'CORS allows all origins'
    );
    assert(
      cors.headers['access-control-allow-methods'],
      'CORS methods header present'
    );
    console.log();
    
    // Test 5: Chat completions (basic structure test)
    console.log('Test 5: Chat completions endpoint structure');
    const chatBody = {
      model: 'test-model',
      messages: [
        { role: 'user', content: 'Hello' }
      ],
      max_tokens: 10
    };
    const chat = await makeRequest('POST', '/v1/chat/completions', chatBody);
    // Note: This might fail if no valid API key is configured
    // We're mainly testing that the endpoint exists and handles the request
    assert(
      chat.status === 200 || chat.status === 401 || chat.status === 500,
      'Chat endpoint is accessible'
    );
    console.log();
    
    // Test 6: Text completions (basic structure test)
    console.log('Test 6: Text completions endpoint structure');
    const completionBody = {
      model: 'test-model',
      prompt: 'Once upon a time',
      max_tokens: 10
    };
    const completion = await makeRequest('POST', '/v1/completions', completionBody);
    assert(
      completion.status === 200 || completion.status === 401 || completion.status === 500,
      'Completions endpoint is accessible'
    );
    console.log();
    
    // Test 7: Invalid endpoint
    console.log('Test 7: Invalid endpoint returns 404');
    const notFound = await makeRequest('GET', '/invalid');
    assert(notFound.status === 404, 'Invalid endpoint returns 404');
    console.log();
    
    // Test 8: Invalid JSON body
    console.log('Test 8: Invalid JSON handling');
    const invalidJson = await new Promise((resolve) => {
      const url = new URL('/v1/chat/completions', BASE_URL);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      };
      
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ status: res.statusCode, body: data });
        });
      });
      
      req.write('invalid json{');
      req.end();
    });
    assert(invalidJson.status === 400, 'Invalid JSON returns 400');
    console.log();
    
  } catch (error) {
    console.log(`❌ Test suite error: ${error.message}`);
    failedTests++;
  }
  
  // Summary
  console.log('─'.repeat(50));
  console.log(`\n📊 Test Results:`);
  console.log(`   Passed: ${passedTests}`);
  console.log(`   Failed: ${failedTests}`);
  console.log(`   Total:  ${passedTests + failedTests}\n`);
  
  if (failedTests === 0) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('⚠️  Some tests failed.');
    process.exit(1);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

console.log('⏳ Waiting 1 second for server to be ready...\n');
setTimeout(runTests, 1000);
