import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';

const HISTOGRAM_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300];

const escapeLabel = (value) => String(value ?? '')
  .replaceAll('\\', '\\\\')
  .replaceAll('\n', '\\n')
  .replaceAll('"', '\\"');

const labels = (values) => Object.entries(values)
  .map(([name, value]) => `${name}="${escapeLabel(value)}"`)
  .join(',');

const increment = (map, key, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount);

const endpointName = (pathname) => {
  if (pathname === '/api/chat') return 'chat';
  if (pathname === '/api/generate') return 'generate';
  if (pathname === '/api/embed' || pathname === '/api/embeddings') return 'embed';
  return 'other';
};

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const fetchInventory = async (upstreamUrl) => {
  try {
    const options = { signal: AbortSignal.timeout(5000) };
    const [tagsResponse, psResponse] = await Promise.all([
      fetch(new URL('/api/tags', upstreamUrl), options),
      fetch(new URL('/api/ps', upstreamUrl), options),
    ]);
    if (!tagsResponse.ok || !psResponse.ok) throw new Error('Ollama inventory endpoint returned an error');
    const [tags, ps] = await Promise.all([tagsResponse.json(), psResponse.json()]);
    return { up: true, available: tags.models ?? [], loaded: ps.models ?? [] };
  } catch {
    return { up: false, available: [], loaded: [] };
  }
};

export class MetricsRegistry {
  constructor(models = [], defaultGroup = 'ollama-default') {
    this.defaultGroup = defaultGroup;
    this.modelGroups = new Map(models.map((model) => [model.name, model.alert_email_group || defaultGroup]));
    this.requests = new Map();
    this.errors = new Map();
    this.promptTokens = new Map();
    this.generatedTokens = new Map();
    this.durations = new Map();
  }

  groupFor(model) {
    return this.modelGroups.get(model) ?? this.defaultGroup;
  }

  recordRequest({ model = 'unknown', endpoint = 'other', status = 0, durationSeconds = 0, promptTokens = 0, generatedTokens = 0, error = false }) {
    const group = this.groupFor(model);
    increment(this.requests, JSON.stringify([model, endpoint, String(status), group]));
    increment(this.promptTokens, JSON.stringify([model, group]), Number(promptTokens) || 0);
    increment(this.generatedTokens, JSON.stringify([model, group]), Number(generatedTokens) || 0);
    if (error) increment(this.errors, JSON.stringify([model, endpoint, group]));

    const durationKey = JSON.stringify([model, endpoint, group]);
    const duration = this.durations.get(durationKey) ?? { count: 0, sum: 0, buckets: new Map() };
    duration.count += 1;
    duration.sum += Number(durationSeconds) || 0;
    for (const bucket of HISTOGRAM_BUCKETS) {
      if (durationSeconds <= bucket) increment(duration.buckets, bucket);
    }
    this.durations.set(durationKey, duration);
  }

  render({ up = false, available = [], loaded = [] } = {}) {
    const availableByModel = new Map(available.map((model) => [model.name ?? model.model, model]));
    const loadedByModel = new Map(loaded.map((model) => [model.name ?? model.model, model]));
    const inventoryModels = new Set([...this.modelGroups.keys(), ...availableByModel.keys(), ...loadedByModel.keys()]);
    const lines = [
      '# HELP ollama_up Whether the configured Ollama upstream is reachable.',
      '# TYPE ollama_up gauge',
      `ollama_up ${up ? 1 : 0}`,
      '# HELP ollama_model_available Whether an Ollama model is installed.',
      '# TYPE ollama_model_available gauge',
    ];
    for (const model of inventoryModels) {
      const group = this.groupFor(model);
      const availableModel = availableByModel.get(model);
      lines.push(`ollama_model_available{${labels({ model, alert_email_group: group })}} ${availableModel ? 1 : 0}`);
    }
    lines.push('# HELP ollama_model_loaded Whether an Ollama model is loaded into memory.', '# TYPE ollama_model_loaded gauge');
    for (const model of inventoryModels) {
      const group = this.groupFor(model);
      lines.push(`ollama_model_loaded{${labels({ model, alert_email_group: group })}} ${loadedByModel.has(model) ? 1 : 0}`);
    }
    lines.push('# HELP ollama_model_size_bytes Ollama model size on disk.', '# TYPE ollama_model_size_bytes gauge');
    for (const model of inventoryModels) {
      const group = this.groupFor(model);
      lines.push(`ollama_model_size_bytes{${labels({ model, alert_email_group: group })}} ${Number(availableByModel.get(model)?.size) || 0}`);
    }
    lines.push('# HELP ollama_model_vram_bytes VRAM allocated to a loaded Ollama model.', '# TYPE ollama_model_vram_bytes gauge');
    for (const model of inventoryModels) {
      const group = this.groupFor(model);
      lines.push(`ollama_model_vram_bytes{${labels({ model, alert_email_group: group })}} ${Number(loadedByModel.get(model)?.size_vram) || 0}`);
    }
    lines.push('# HELP ollama_model_context_length Context length allocated to a loaded Ollama model.', '# TYPE ollama_model_context_length gauge');
    for (const model of inventoryModels) {
      const group = this.groupFor(model);
      lines.push(`ollama_model_context_length{${labels({ model, alert_email_group: group })}} ${Number(loadedByModel.get(model)?.context_length) || 0}`);
    }
    lines.push(
      '# HELP ollama_requests_total Ollama API requests observed by the proxy.',
      '# TYPE ollama_requests_total counter',
    );

    for (const [key, value] of this.requests) {
      const [model, endpoint, status, group] = JSON.parse(key);
      lines.push(`ollama_requests_total{${labels({ model, endpoint, status, alert_email_group: group })}} ${value}`);
    }
    lines.push('# HELP ollama_errors_total Ollama API errors observed by the proxy.', '# TYPE ollama_errors_total counter');
    for (const [key, value] of this.errors) {
      const [model, endpoint, group] = JSON.parse(key);
      lines.push(`ollama_errors_total{${labels({ model, endpoint, alert_email_group: group })}} ${value}`);
    }
    lines.push('# HELP ollama_prompt_tokens_total Prompt tokens processed by Ollama.', '# TYPE ollama_prompt_tokens_total counter');
    for (const [key, value] of this.promptTokens) {
      const [model, group] = JSON.parse(key);
      lines.push(`ollama_prompt_tokens_total{${labels({ model, alert_email_group: group })}} ${value}`);
    }
    lines.push('# HELP ollama_generated_tokens_total Tokens generated by Ollama.', '# TYPE ollama_generated_tokens_total counter');
    for (const [key, value] of this.generatedTokens) {
      const [model, group] = JSON.parse(key);
      lines.push(`ollama_generated_tokens_total{${labels({ model, alert_email_group: group })}} ${value}`);
    }
    lines.push('# HELP ollama_tokens_total Total input and output tokens processed by Ollama.', '# TYPE ollama_tokens_total counter');
    const tokenKeys = new Set([...this.promptTokens.keys(), ...this.generatedTokens.keys()]);
    for (const key of tokenKeys) {
      const [model, group] = JSON.parse(key);
      const total = (this.promptTokens.get(key) ?? 0) + (this.generatedTokens.get(key) ?? 0);
      lines.push(`ollama_tokens_total{${labels({ model, alert_email_group: group })}} ${total}`);
    }
    lines.push('# HELP ollama_request_duration_seconds Ollama proxy request duration.', '# TYPE ollama_request_duration_seconds histogram');
    for (const [key, duration] of this.durations) {
      const [model, endpoint, group] = JSON.parse(key);
      for (const bucket of HISTOGRAM_BUCKETS) {
        lines.push(`ollama_request_duration_seconds_bucket{${labels({ model, endpoint, alert_email_group: group, le: bucket })}} ${duration.buckets.get(bucket) ?? 0}`);
      }
      lines.push(`ollama_request_duration_seconds_bucket{${labels({ model, endpoint, alert_email_group: group, le: '+Inf' })}} ${duration.count}`);
      lines.push(`ollama_request_duration_seconds_sum{${labels({ model, endpoint, alert_email_group: group })}} ${duration.sum}`);
      lines.push(`ollama_request_duration_seconds_count{${labels({ model, endpoint, alert_email_group: group })}} ${duration.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const createOllamaMonitor = ({ upstreamUrl, models = [], defaultGroup = 'ollama-default', registry = null }) => {
  const upstream = new URL(upstreamUrl);
  const metrics = registry ?? new MetricsRegistry(models, defaultGroup);

  return createServer(async (clientRequest, clientResponse) => {
    const requestUrl = new URL(clientRequest.url ?? '/', 'http://ollama-monitor');
    if (requestUrl.pathname === '/healthz') {
      clientResponse.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      clientResponse.end('ok\n');
      return;
    }
    if (requestUrl.pathname === '/metrics') {
      const inventory = await fetchInventory(upstream);
      clientResponse.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      clientResponse.end(metrics.render(inventory));
      return;
    }

    const startedAt = process.hrtime.bigint();
    const endpoint = endpointName(requestUrl.pathname);
    const requestBodyChunks = [];
    let capturedBytes = 0;
    const captureLimit = 1024 * 1024;
    let requestModel = 'unknown';
    let recorded = false;

    const record = ({ status = 0, payload = null, error = false } = {}) => {
      if (recorded) return;
      recorded = true;
      if (endpoint === 'other') return;
      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      metrics.recordRequest({
        model: payload?.model || requestModel,
        endpoint,
        status,
        durationSeconds,
        promptTokens: payload?.prompt_eval_count,
        generatedTokens: payload?.eval_count,
        error: error || Boolean(payload?.error) || status >= 400,
      });
    };

    const upstreamPath = `${upstream.pathname.replace(/\/$/, '')}${clientRequest.url ?? '/'}`;
    const requestImpl = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    const upstreamRequest = requestImpl({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: clientRequest.method,
      path: upstreamPath,
      headers: { ...clientRequest.headers, host: upstream.host },
    }, (upstreamResponse) => {
      const responseHeaders = { ...upstreamResponse.headers };
      delete responseHeaders.connection;
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);

      let lineBuffer = '';
      let finalPayload = null;
      let streamError = false;
      const observeLine = (line) => {
        if (!line.trim()) return;
        const payload = parseJson(line);
        if (!payload) return;
        if (payload.model || payload.done || payload.error) finalPayload = payload;
        if (payload.error) streamError = true;
      };

      upstreamResponse.on('data', (chunk) => {
        clientResponse.write(chunk);
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) observeLine(line);
      });
      upstreamResponse.on('end', () => {
        observeLine(lineBuffer);
        clientResponse.end();
        record({ status: upstreamResponse.statusCode ?? 502, payload: finalPayload, error: streamError });
      });
      upstreamResponse.on('error', (error) => {
        clientResponse.destroy(error);
        record({ status: upstreamResponse.statusCode ?? 502, payload: finalPayload, error: true });
      });
    });

    upstreamRequest.on('error', () => {
      if (!clientResponse.headersSent) {
        clientResponse.writeHead(502, { 'content-type': 'application/json' });
        clientResponse.end('{"error":"Ollama upstream is unavailable"}\n');
      } else {
        clientResponse.end();
      }
      record({ status: 502, error: true });
    });

    clientRequest.on('data', (chunk) => {
      if (capturedBytes < captureLimit) {
        const captured = chunk.subarray(0, captureLimit - capturedBytes);
        requestBodyChunks.push(captured);
        capturedBytes += captured.length;
      }
      upstreamRequest.write(chunk);
    });
    clientRequest.on('end', () => {
      const requestBody = parseJson(Buffer.concat(requestBodyChunks).toString('utf8'));
      requestModel = requestBody?.model || 'unknown';
      upstreamRequest.end();
    });
    clientRequest.on('error', (error) => upstreamRequest.destroy(error));
  });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.env.OLLAMA_MODELS_CONFIG ?? '/config/models.json';
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const upstreamUrl = process.env.OLLAMA_UPSTREAM_URL ?? 'http://host.docker.internal:11434';
  const registry = new MetricsRegistry(config.models ?? [], config.default_alert_email_group ?? 'ollama-default');
  const server = createOllamaMonitor({
    upstreamUrl,
    registry,
  });
  const host = process.env.OLLAMA_MONITOR_HOST ?? '0.0.0.0';
  const port = Number(process.env.OLLAMA_MONITOR_PORT ?? 11435);
  server.listen(port, host, () => process.stdout.write(`Ollama monitor listening on ${host}:${port}\n`));

  const metricsHost = process.env.OLLAMA_METRICS_HOST;
  const metricsPort = Number(process.env.OLLAMA_METRICS_PORT ?? 0);
  if (metricsHost && metricsPort && (metricsHost !== host || metricsPort !== port)) {
    const metricsServer = createOllamaMonitor({ upstreamUrl, registry });
    metricsServer.listen(metricsPort, metricsHost, () => process.stdout.write(`Ollama metrics listening on ${metricsHost}:${metricsPort}\n`));
  }
}
