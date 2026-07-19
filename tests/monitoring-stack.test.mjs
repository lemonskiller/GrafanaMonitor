import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('ships a pinned, private-by-default monitoring stack', async () => {
  const compose = await read('docker-compose.yml');

  assert.match(compose, /prom\/prometheus:v3\.12\.0/);
  assert.match(compose, /grafana\/grafana:13\.1\.0/);
  assert.match(compose, /PROMETHEUS_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /GRAFANA_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /GF_SECURITY_ADMIN_PASSWORD__FILE/);
  assert.doesNotMatch(compose, /GF_SECURITY_ADMIN_PASSWORD:\s*[^$]/);
});

test('discovers multiple NextOffer instances from a target file', async () => {
  const prometheus = await read('prometheus/prometheus.yml');
  const targets = JSON.parse(await read('prometheus/targets/nextoffer.json'));

  assert.match(prometheus, /metrics_path: \/actuator\/prometheus/);
  assert.match(prometheus, /honor_labels: true/);
  assert.match(prometheus, /file_sd_configs:/);
  assert.match(prometheus, /\/etc\/prometheus\/targets\/\*\.json/);
  assert.ok(Array.isArray(targets));
  assert.ok(Array.isArray(targets[0].targets));
  assert.ok(targets[0].targets.length >= 2);
});

test('automatically provisions the Prometheus datasource and NextOffer dashboard', async () => {
  const datasource = await read('grafana/provisioning/datasources/prometheus.yml');
  const provider = await read('grafana/provisioning/dashboards/dashboards.yml');
  const dashboard = JSON.parse(await read('grafana/dashboards/nextoffer-overview.json'));

  assert.match(datasource, /uid: prometheus-nextoffer/);
  assert.match(datasource, /url: http:\/\/prometheus:9090/);
  assert.match(provider, /folder: NextOffer/);
  assert.equal(dashboard.uid, 'nextoffer-service-overview');
  assert.ok(dashboard.panels.length >= 8);
  assert.match(JSON.stringify(dashboard), /histogram_quantile\(0\.95/);
  assert.match(JSON.stringify(dashboard), /hikaricp_connections_active/);
  assert.match(JSON.stringify(dashboard), /sum\(up\{job=\\"nextoffer\\"\}\)/);
});
