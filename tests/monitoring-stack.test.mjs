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

test('ships host, container, probe, and alerting collectors', async () => {
  const compose = await read('docker-compose.yml');

  assert.match(compose, /prom\/node-exporter:/);
  assert.match(compose, /google\/cadvisor:/);
  assert.match(compose, /prom\/blackbox-exporter:/);
  assert.match(compose, /prom\/alertmanager:/);
  assert.match(compose, /ALERTMANAGER_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(compose, /BLACKBOX_BIND_ADDRESS:-127\.0\.0\.1/);
});

test('discovers NextOffer instances from a target file', async () => {
  const prometheus = await read('prometheus/prometheus.yml');
  const targets = JSON.parse(await read('prometheus/targets/nextoffer.json'));

  assert.match(prometheus, /metrics_path: \/actuator\/prometheus/);
  assert.match(prometheus, /honor_labels: true/);
  assert.match(prometheus, /file_sd_configs:/);
  assert.match(prometheus, /\/etc\/prometheus\/targets\/nextoffer\.json/);
  assert.ok(Array.isArray(targets));
  assert.ok(Array.isArray(targets[0].targets));
  assert.ok(targets[0].targets.length >= 1);
});

test('discovers infrastructure, training, container, and probe targets', async () => {
  const prometheus = await read('prometheus/prometheus.yml');
  const hosts = JSON.parse(await read('prometheus/targets/hosts.json'));
  const training = JSON.parse(await read('prometheus/targets/training.json'));
  const probes = JSON.parse(await read('prometheus/targets/probes.json'));

  for (const job of ['node', 'cadvisor', 'gpu', 'training', 'blackbox']) {
    assert.match(prometheus, new RegExp(`job_name: ${job}`));
  }
  assert.match(prometheus, /alertmanagers:/);
  assert.match(prometheus, /rule_files:/);
  assert.ok(Array.isArray(hosts));
  assert.ok(Array.isArray(training));
  assert.ok(Array.isArray(probes));
});

test('routes model failures to model-specific email receivers', async () => {
  const rules = await read('prometheus/rules/training-alerts.yml');
  const alertmanager = await read('alertmanager/alertmanager.yml');
  const compose = await read('docker-compose.yml');

  for (const alert of ['TrainingTargetDown', 'TrainingJobFailed', 'TrainingProgressStalled']) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
  assert.match(rules, /alert_email_group/);
  assert.match(alertmanager, /alert_email_group="recommendation-team"/);
  assert.match(alertmanager, /receiver: recommendation-team-email/);
  assert.match(alertmanager, /alert_email_group="vision-team"/);
  assert.match(alertmanager, /receiver: vision-team-email/);
  assert.match(alertmanager, /smtp_auth_password_file: \/run\/secrets\/smtp_password/);
  assert.match(compose, /smtp_password/);
});

test('provides a remote host agent and category-specific infrastructure dashboards', async () => {
  const agent = await read('agent/docker-compose.yml');
  const host = JSON.parse(await read('grafana/dashboards/infrastructure/host-overview.json'));
  const container = JSON.parse(await read('grafana/dashboards/infrastructure/container-overview.json'));
  const gpu = JSON.parse(await read('grafana/dashboards/infrastructure/gpu-overview.json'));

  assert.match(agent, /prom\/node-exporter:v1\.11\.1/);
  assert.match(agent, /ghcr\.io\/google\/cadvisor:v0\.57\.0/);
  assert.match(agent, /nvcr\.io\/nvidia\/k8s\/dcgm-exporter:4\.6\.0-4\.8\.3/);
  assert.match(agent, /profiles: \[gpu\]/);
  assert.equal(host.uid, 'infrastructure-host-overview');
  assert.match(JSON.stringify(container), /container_cpu_usage_seconds_total/);
  assert.match(JSON.stringify(gpu), /host_gpu_utilization_percent/);
});

test('alerts on host, container, gpu, and endpoint failures', async () => {
  const rules = await read('prometheus/rules/infrastructure-alerts.yml');

  for (const alert of [
    'NodeDown',
    'HostMemoryHigh',
    'HostDiskAlmostFull',
    'ContainerMetricsMissing',
    'GpuXidError',
    'EndpointProbeFailed',
  ]) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
});

test('collects and alerts on failed systemd services', async () => {
  const compose = await read('docker-compose.yml');
  const agent = await read('agent/docker-compose.yml');
  const rules = await read('prometheus/rules/infrastructure-alerts.yml');

  assert.match(compose, /\/run\/dbus:\/run\/dbus:ro/);
  assert.match(agent, /\/run\/dbus:\/run\/dbus:ro/);
  assert.match(rules, /alert: SystemdUnitFailed/);
  assert.match(rules, /node_systemd_unit_state/);
});

test('automatically provisions the Prometheus datasource and NextOffer dashboard', async () => {
  const datasource = await read('grafana/provisioning/datasources/prometheus.yml');
  const provider = await read('grafana/provisioning/dashboards/dashboards.yml');
  const dashboard = JSON.parse(await read('grafana/dashboards/nextoffer/nextoffer-overview.json'));

  assert.match(datasource, /uid: prometheus-nextoffer/);
  assert.match(datasource, /url: http:\/\/prometheus:9090/);
  assert.match(provider, /folder: NextOffer/);
  assert.equal(dashboard.uid, 'nextoffer-service-overview');
  assert.ok(dashboard.panels.length >= 8);
  assert.match(JSON.stringify(dashboard), /max_over_time\(http_server_requests_seconds_max/);
  assert.match(JSON.stringify(dashboard), /hikaricp_connections_active/);
  assert.match(JSON.stringify(dashboard), /sum\(up\{job=\\"nextoffer\\"\}\)/);
});

test('integrates Ollama monitoring and model-specific email alerts', async () => {
  const compose = await read('docker-compose.yml');
  const prometheus = await read('prometheus/prometheus.yml');
  const rules = await read('prometheus/rules/ollama-alerts.yml');
  const alertmanager = await read('alertmanager/alertmanager.yml');
  const models = JSON.parse(await read('ollama-monitor/models.json'));

  assert.match(compose, /ollama-monitor:/);
  assert.match(compose, /OLLAMA_UPSTREAM_URL/);
  assert.match(compose, /network_mode: host/);
  assert.match(prometheus, /job_name: ollama/);
  assert.match(prometheus, /host\.docker\.internal:11435/);
  for (const alert of ['OllamaDown', 'OllamaModelUnavailable', 'OllamaModelErrors']) {
    assert.match(rules, new RegExp(`alert: ${alert}`));
  }
  assert.match(alertmanager, /to: yangzhiyu_yzy@163\.com/);
  assert.match(alertmanager, /alert_email_group="ollama-qwen"/);
  assert.match(alertmanager, /receiver: ollama-qwen-email/);
  assert.match(alertmanager, /name: ollama-qwen-email[\s\S]*to: 'yangzhiyu_yzy@163\.com'/);
  assert.ok(models.models.every((model) => model.name && model.alert_email_group));
});

test('provisions an Ollama dashboard alongside NextOffer', async () => {
  const provider = await read('grafana/provisioning/dashboards/dashboards.yml');
  const dashboard = JSON.parse(await read('grafana/dashboards/ollama/ollama-overview.json'));
  const serialized = JSON.stringify(dashboard);

  assert.match(provider, /folder: Ollama/);
  assert.match(provider, /path: \/var\/lib\/grafana\/dashboards\/ollama/);
  assert.equal(dashboard.uid, 'ollama-model-usage-overview');
  assert.ok(dashboard.panels.length >= 12);
  assert.match(serialized, /ollama_prompt_tokens_total/);
  assert.match(serialized, /ollama_generated_tokens_total/);
  assert.match(serialized, /ollama_tokens_total/);
  assert.match(serialized, /ollama_errors_total/);
  assert.match(serialized, /ollama_request_duration_seconds_bucket/);
  assert.match(serialized, /ollama_model_vram_bytes/);
});
