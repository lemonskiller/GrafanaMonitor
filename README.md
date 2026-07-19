# GrafanaMonitor

面向部署机器、Docker 容器、NVIDIA GPU、模型训练任务和通用服务的独立监控栈。中心节点运行 Prometheus、Grafana、Alertmanager 与 Blackbox Exporter；每台被监控机器运行 node-exporter、cAdvisor，并可选运行 DCGM Exporter。

业务侧的用户 Token 明细继续保存在 NextOffer MySQL 中。本仓库只保存低基数性能指标，不要把用户邮箱、用户 ID、请求 ID 等高基数或敏感数据写入 Prometheus 标签。

## 监控范围

| 范围 | 采集方式 | 主要内容 |
| --- | --- | --- |
| Linux 主机 | node-exporter | CPU、内存、磁盘、网络、systemd 服务、进程数量 |
| Docker | cAdvisor | 所有容器的 CPU、内存、网络和存活状态 |
| 容器业务指标 | Docker 服务发现 | 带 `prometheus.io/*` 标签的容器 `/metrics` |
| NVIDIA GPU | node-exporter textfile collector 或 DCGM Exporter | GPU/显存利用率、温度、功耗、XID 错误 |
| 目录大小 | 主机自定义采集器 + node-exporter textfile collector | 指定根目录下最大的一级目录、目录大小趋势、扫描延迟 |
| 模型训练 | Prometheus Client | loss、运行状态、失败状态、最后进度时间 |
| HTTP/TCP 服务 | Blackbox Exporter | 可用性、延迟、TLS 与 TCP 连接 |
| 告警通知 | Alertmanager | 运维默认邮箱、按模型或团队分组邮箱 |

Grafana 会自动创建 `NextOffer / NextOffer 服务监控` 和 `Infrastructure / 基础设施 / 容器 / 模型训练总览` 两个仪表盘。

## 前置条件

- 中心节点和被监控节点安装 Docker Engine 与 Docker Compose v2。
- 中心节点能通过私网访问被监控节点的 `9100`、`8080`，GPU 节点还需访问 `9400`。
- GPU 节点已安装 NVIDIA 驱动和 NVIDIA Container Toolkit。
- 防火墙只允许中心节点访问 exporter 端口，不要暴露到公网。

## 1. 部署被监控节点

在每台部署机器上复制 `agent/docker-compose.yml`，绑定机器的私网 IP：

```bash
cd agent
AGENT_BIND_ADDRESS=10.0.0.11 docker compose up -d
```

GPU 节点额外启用 `gpu` profile：

```bash
AGENT_BIND_ADDRESS=10.0.0.11 docker compose --profile gpu up -d
```

在中心仓库的 `prometheus/targets/hosts.json` 中登记节点。目标端口统一写 `9100`，Prometheus 会自动派生 cAdvisor 的 `8080` 和 DCGM 的 `9400`：

```json
[
  {
    "targets": ["10.0.0.11:9100"],
    "labels": {
      "node": "gpu-node-01",
      "environment": "production",
      "cluster": "training",
      "gpu": "true"
    }
  }
]
```

非 GPU 节点设置 `"gpu": "false"`。增删目标文件中的机器不需要重启 Prometheus，最长约 30 秒自动生效。

## 2. 接入服务

### NextOffer

编辑 `prometheus/targets/nextoffer.json`，填入暴露 `/actuator/prometheus` 的私网管理端口。

### 通用 Prometheus 指标端点

编辑 `prometheus/targets/services.json`。每组目标可指定 `metrics_path` 和 `scheme`：

```json
[
  {
    "targets": ["10.0.0.11:9000"],
    "labels": {
      "service": "inference-api",
      "environment": "production",
      "metrics_path": "/metrics",
      "scheme": "http"
    }
  }
]
```

中心节点上的 Docker 容器还可以用标签自动发现业务指标：

```yaml
services:
  inference-api:
    labels:
      prometheus.io/scrape: "true"
      prometheus.io/port: "9000"
      prometheus.io/path: "/metrics"
      prometheus.io/scheme: "http"
```

cAdvisor 会无条件采集所有容器的资源指标；上述标签只用于采集容器自己的业务指标。Prometheus 通过只读权限的 Docker socket proxy 发现容器，不直接挂载 Docker socket。

### HTTP/TCP 可用性

编辑 `prometheus/targets/probes.json`，HTTP/HTTPS 使用 `http_2xx`，数据库、缓存或自定义 TCP 服务使用 `tcp_connect`：

```json
[
  {
    "targets": ["https://service.example.com/health"],
    "labels": {"service": "inference-api", "environment": "production", "module": "http_2xx"}
  },
  {
    "targets": ["10.0.0.11:5432"],
    "labels": {"service": "postgres", "environment": "production", "module": "tcp_connect"}
  }
]
```

## 3. 接入模型训练

训练进程暴露 Prometheus `/metrics`，并至少提供以下指标：

| 指标 | 类型 | 含义 |
| --- | --- | --- |
| `training_job_running` | Gauge | 运行中为 `1`，结束后为 `0` |
| `training_job_failed` | Gauge | 故障为 `1`，正常为 `0` |
| `training_last_progress_timestamp_seconds` | Gauge | 每次训练进度更新时写入 Unix 时间戳 |
| `training_loss` | Gauge | 当前 loss，用于仪表盘趋势 |

Python 示例：

```python
import time
from prometheus_client import Gauge, start_http_server

running = Gauge("training_job_running", "Whether the training job is running")
failed = Gauge("training_job_failed", "Whether the training job has failed")
last_progress = Gauge("training_last_progress_timestamp_seconds", "Last progress Unix timestamp")
loss_metric = Gauge("training_loss", "Current training loss")

start_http_server(8000)
running.set(1)
failed.set(0)

try:
    for loss in train():
        loss_metric.set(loss)
        last_progress.set(time.time())
except Exception:
    failed.set(1)
    raise
finally:
    running.set(0)
```

然后在 `prometheus/targets/training.json` 中登记任务，并通过 `alert_email_group` 选择邮件接收组：

```json
[
  {
    "targets": ["10.0.0.11:8000"],
    "labels": {
      "service": "model-training",
      "model": "recommendation-v2",
      "run_id": "20260719-001",
      "environment": "production",
      "alert_email_group": "recommendation-team"
    }
  }
]
```

任务正常结束并关闭指标端点后，应从该文件删除目标，否则 `TrainingTargetDown` 会按故障处理。也可以让常驻 sidecar 继续暴露最终状态。

## 4. 配置分模型告警邮箱

编辑 `alertmanager/alertmanager.yml` 的 SMTP 配置，将 `example.com` 地址替换为真实值。仓库已提供 `recommendation-team` 和 `vision-team` 两个示例路由：

```yaml
route:
  receiver: operations-email
  routes:
    - matchers: ['alert_email_group="recommendation-team"']
      receiver: recommendation-team-email

receivers:
  - name: recommendation-team-email
    email_configs:
      - to: recommendation-owner@example.com
        send_resolved: true
```

每个模型可以使用独立的 `alert_email_group`；添加新组时同时增加一条 route 和同名 receiver。多个模型共用邮箱时，使用同一个组即可。未匹配任何组的告警发送到 `operations-email`。

SMTP 密码使用 Docker secret，不写入 Git：

```bash
mkdir -p secrets
umask 077
printf '%s' 'Grafana 管理员强密码' > secrets/grafana-admin-password
printf '%s' 'SMTP 密码或应用专用密码' > secrets/smtp-password
```

训练告警包括：指标端点失联 2 分钟、训练显式失败、运行任务超过 15 分钟没有进度。邮件会包含模型名、run ID、实例和告警状态。通用规则还覆盖节点失联、内存高、磁盘将满、systemd 服务失败、容器监控失联、GPU XID 错误和 HTTP/TCP 探测失败。

## 5. 启动中心栈

```bash
docker compose up -d
```

默认只监听中心节点本机：

- Grafana: http://127.0.0.1:3001
- Prometheus: http://127.0.0.1:9090
- Alertmanager: http://127.0.0.1:9093
- Blackbox Exporter: http://127.0.0.1:9115

Grafana 默认用户名为 `admin`，密码来自 `secrets/grafana-admin-password`。远程访问推荐使用 SSH 隧道：

```bash
ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 user@monitor-host
```

如果必须对团队开放 Grafana，请通过带 HTTPS 和身份认证的反向代理发布，并保持 Prometheus、Alertmanager 和 exporter 端口不对公网开放。

## 6. 启用本机 GPU 和目录大小采集

中心节点如果也需要监控本机 GPU 与目录大小，启用主机采集器：

```bash
bash scripts/install-host-metrics-service.sh
docker compose up -d node-exporter prometheus grafana
```

脚本会在 root 下安装系统级 service；非 root 下安装当前用户的 systemd user service。生产环境建议使用系统级 service，确保机器重启后无需用户登录也会自动采集。

默认采集 `/home/wuxinze` 和 `/nfs/wxz/others` 下最大的 30 个一级目录，每 5 分钟更新一次。需要调整时修改 `systemd/grafana-host-metrics.service` 里的 `HOST_DIRECTORY_ROOTS`、`HOST_DIRECTORY_TOP_N` 和 `HOST_METRICS_INTERVAL`，然后重新安装服务。

## 运维与验证

```bash
docker compose ps
docker compose logs --tail=200 prometheus alertmanager grafana blackbox-exporter
curl -X POST http://127.0.0.1:9090/-/reload
curl -X POST http://127.0.0.1:9093/-/reload
node --test tests/monitoring-stack.test.mjs
docker compose config --quiet
```

在 Prometheus 的 `/targets` 确认目标为 `UP`，在 `/alerts` 确认规则已加载。正式上线前建议临时停止一个训练指标端点，验证告警从 `PENDING` 进入 `FIRING`，并确认邮件到达该模型对应的邮箱。

数据保存在 `prometheus_data`、`grafana_data` 和 `alertmanager_data` Docker 卷中。升级镜像前应备份这些卷；采集、告警、数据源和仪表盘配置均已纳入 Git。
