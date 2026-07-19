#!/usr/bin/env bash
set -euo pipefail

REPO_DIR=${GRAFANA_MONITOR_DIR:-/nfs/wxz/others/GrafanaMonitor}
SERVICE_NAME=grafana-host-metrics.service

install -d "$REPO_DIR/runtime/textfile"

if [ "$(id -u)" -eq 0 ]; then
  install -m 0644 "$REPO_DIR/systemd/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  systemctl status "$SERVICE_NAME" --no-pager --lines=20
else
  install -d "$HOME/.config/systemd/user"
  install -m 0644 "$REPO_DIR/systemd/user/$SERVICE_NAME" "$HOME/.config/systemd/user/$SERVICE_NAME"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  systemctl --user status "$SERVICE_NAME" --no-pager --lines=20
fi
