import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createOllamaMonitor, MetricsRegistry } from '../ollama-monitor/server.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test('records Ollama usage and errors with the model email group', () => {
  const metrics = new MetricsRegistry([
    { name: 'qwen3:8b', alert_email_group: 'ollama-qwen' },
  ]);

  metrics.recordRequest({
    model: 'qwen3:8b',
    endpoint: 'chat',
    status: 500,
    durationSeconds: 2.5,
    promptTokens: 12,
    generatedTokens: 4,
    error: true,
  });

  const output = metrics.render({ up: true, available: [], loaded: [] });
  const labels = 'model="qwen3:8b",endpoint="chat",status="500",alert_email_group="ollama-qwen"';

  assert.match(output, new RegExp(`ollama_requests_total\\{${labels}\\} 1`));
  assert.match(output, /ollama_errors_total\{model="qwen3:8b",endpoint="chat",alert_email_group="ollama-qwen"\} 1/);
  assert.match(output, /ollama_prompt_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 12/);
  assert.match(output, /ollama_generated_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 4/);
  assert.match(output, /ollama_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 16/);
  assert.match(output, /ollama_request_duration_seconds_count\{model="qwen3:8b",endpoint="chat",alert_email_group="ollama-qwen"\} 1/);
});

test('exports configured model availability and runtime memory', () => {
  const metrics = new MetricsRegistry([
    { name: 'qwen3:8b', alert_email_group: 'ollama-qwen' },
    { name: 'deepseek-r1:8b', alert_email_group: 'ollama-deepseek' },
  ]);

  const output = metrics.render({
    up: true,
    available: [{ name: 'qwen3:8b', size: 5_000_000_000 }],
    loaded: [{ name: 'qwen3:8b', size_vram: 4_000_000_000, context_length: 8192 }],
  });

  assert.match(output, /ollama_model_available\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 1/);
  assert.match(output, /ollama_model_available\{model="deepseek-r1:8b",alert_email_group="ollama-deepseek"\} 0/);
  assert.match(output, /ollama_model_loaded\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 1/);
  assert.match(output, /ollama_model_vram_bytes\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 4000000000/);
  assert.match(output, /ollama_model_context_length\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 8192/);
});

test('proxies streaming Ollama responses and records input, output, and total tokens', async (t) => {
  const upstream = createServer((request, response) => {
    if (request.url === '/api/chat') {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('{"model":"qwen3:8b","message":{"content":"hi"},"done":false}\n');
      response.end('{"model":"qwen3:8b","done":true,"prompt_eval_count":7,"eval_count":3,"total_duration":2000000000}\n');
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const monitor = createOllamaMonitor({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    models: [{ name: 'qwen3:8b', alert_email_group: 'ollama-qwen' }],
  });
  const monitorPort = await listen(monitor);
  t.after(() => close(monitor));

  const response = await fetch(`http://127.0.0.1:${monitorPort}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'hello' }] }),
  });
  const body = await response.text();
  const metrics = await fetch(`http://127.0.0.1:${monitorPort}/metrics`).then((result) => result.text());

  assert.equal(response.status, 200);
  assert.match(body, /"done":true/);
  assert.match(metrics, /ollama_prompt_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 7/);
  assert.match(metrics, /ollama_generated_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 3/);
  assert.match(metrics, /ollama_tokens_total\{model="qwen3:8b",alert_email_group="ollama-qwen"\} 10/);
});

test('counts Ollama errors returned inside a successful response stream', async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end('{"error":"model runner crashed"}\n');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const monitor = createOllamaMonitor({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    models: [{ name: 'qwen3:8b', alert_email_group: 'ollama-qwen' }],
  });
  const monitorPort = await listen(monitor);
  t.after(() => close(monitor));

  await fetch(`http://127.0.0.1:${monitorPort}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3:8b', prompt: 'hello' }),
  }).then((response) => response.text());
  const metrics = await fetch(`http://127.0.0.1:${monitorPort}/metrics`).then((response) => response.text());

  assert.match(metrics, /ollama_errors_total\{model="qwen3:8b",endpoint="generate",alert_email_group="ollama-qwen"\} 1/);
});
