# GrafanaMonitor

NextOffer 的独立服务监控栈，使用 Prometheus OSS 采集多台后端实例，使用 Grafana OSS 展示请求、耗时、错误率、JVM、CPU 和数据库连接池指标。

业务侧的用户 Token 明细继续保存在 NextOffer MySQL 中。本仓库只负责低基数的服务性能指标，避免把用户邮箱、用户 ID 等业务信息写入 Prometheus 标签。

## 前置条件

- Docker Engine 与 Docker Compose v2
- 监控服务器能通过私网访问每台 NextOffer 的管理端口 `9091`
- 每台 NextOffer 已暴露 `/actuator/prometheus`

NextOffer 实例建议这样启动：

```bash
MANAGEMENT_BIND_ADDRESS="10.0.0.11" \
MANAGEMENT_PORT="9091" \
NEXT_OFFER_INSTANCE_ID="nextoffer-prod-01" \
docker compose up -d --build
```

`MANAGEMENT_BIND_ADDRESS` 应填写部署机的私网 IP，不要把管理端口暴露到公网。通过安全组或防火墙只允许监控服务器访问 `9091`。

## 配置采集目标

编辑 `prometheus/targets/nextoffer.json`，把示例地址替换为真实的 NextOffer 私网地址：

```json
[
  {
    "targets": [
      "10.0.0.11:9091",
      "10.0.0.12:9091"
    ],
    "labels": {
      "service": "nextoffer"
    }
  }
]
```

Prometheus 每 30 秒重新读取目标文件。增删机器只需修改该文件，不需要重启监控服务。

## 启动

先创建不入库的 Grafana 管理员密码：

```bash
mkdir -p secrets
umask 077
printf '%s' '请替换为高强度密码' > secrets/grafana-admin-password
```

启动服务：

```bash
docker compose up -d
```

默认地址：

- Grafana: http://127.0.0.1:3001
- Prometheus: http://127.0.0.1:9090

Grafana 默认用户名是 `admin`，密码来自 `secrets/grafana-admin-password`。Prometheus 数据源和 `NextOffer / NextOffer 服务监控` 仪表盘会自动创建。

## 远程访问

默认只监听监控服务器本机，推荐通过 SSH 隧道访问：

```bash
ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 user@monitor-host
```

如果必须对团队开放 Grafana，请通过带 HTTPS 和身份认证的反向代理发布，并保持 Prometheus 端口不对公网开放。可用环境变量覆盖监听地址和端口：

```bash
GRAFANA_BIND_ADDRESS="10.0.0.20" \
GRAFANA_PORT="3001" \
GRAFANA_ROOT_URL="https://grafana.example.com" \
docker compose up -d
```

## 运维

检查采集状态：

```bash
docker compose ps
docker compose logs --tail=200 prometheus grafana
```

重新加载修改后的 Prometheus 配置：

```bash
curl -X POST http://127.0.0.1:9090/-/reload
```

数据分别保存在 Docker 卷 `prometheus_data` 和 `grafana_data`。升级镜像前应先备份这两个卷；仪表盘和数据源配置本身已纳入 Git。

## 验证

```bash
node --test tests/monitoring-stack.test.mjs
docker compose config --quiet
```
