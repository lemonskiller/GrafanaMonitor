#!/usr/bin/env bash
set -euo pipefail

OUTPUT_FILE=${HOST_METRICS_OUTPUT_FILE:-/nfs/wxz/others/GrafanaMonitor/runtime/textfile/host_custom.prom}
ROOTS=${HOST_DIRECTORY_ROOTS:-"/home/wuxinze /nfs/wxz/others"}
TOP_N=${HOST_DIRECTORY_TOP_N:-30}
DU_TIMEOUT=${HOST_DIRECTORY_DU_TIMEOUT:-8}
INTERVAL=${HOST_METRICS_INTERVAL:-60}
NODE_LABEL=${HOST_NODE_LABEL:-monitoring-host}
ENV_LABEL=${HOST_ENVIRONMENT_LABEL:-monitoring}

escape_label() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/ /g'
}

write_metrics_once() {
  local tmp
  tmp="${OUTPUT_FILE}.$$"
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  {
    echo '# HELP host_gpu_info GPU identity information from nvidia-smi.'
    echo '# TYPE host_gpu_info gauge'
    echo '# HELP host_gpu_utilization_percent GPU utilization percent from nvidia-smi.'
    echo '# TYPE host_gpu_utilization_percent gauge'
    echo '# HELP host_gpu_memory_used_bytes GPU memory used bytes from nvidia-smi.'
    echo '# TYPE host_gpu_memory_used_bytes gauge'
    echo '# HELP host_gpu_memory_total_bytes GPU memory total bytes from nvidia-smi.'
    echo '# TYPE host_gpu_memory_total_bytes gauge'
    echo '# HELP host_gpu_temperature_celsius GPU temperature from nvidia-smi.'
    echo '# TYPE host_gpu_temperature_celsius gauge'
    echo '# HELP host_gpu_power_draw_watts GPU power draw from nvidia-smi.'
    echo '# TYPE host_gpu_power_draw_watts gauge'
    echo '# HELP host_gpu_power_limit_watts GPU power limit from nvidia-smi.'
    echo '# TYPE host_gpu_power_limit_watts gauge'

    if command -v nvidia-smi >/dev/null 2>&1; then
      nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits 2>/dev/null |
      while IFS=',' read -r index uuid name util mem_used mem_total temp power_draw power_limit; do
        index=$(echo "${index:-}" | xargs)
        uuid=$(echo "${uuid:-}" | xargs)
        name=$(echo "${name:-}" | xargs)
        util=$(echo "${util:-0}" | xargs)
        mem_used=$(echo "${mem_used:-0}" | xargs)
        mem_total=$(echo "${mem_total:-0}" | xargs)
        temp=$(echo "${temp:-0}" | xargs)
        power_draw=$(echo "${power_draw:-0}" | xargs)
        power_limit=$(echo "${power_limit:-0}" | xargs)
        [ "$util" = "[N/A]" ] && util=0
        [ "$power_draw" = "[N/A]" ] && power_draw=0
        [ "$power_limit" = "[N/A]" ] && power_limit=0
        labels="node=\"$(escape_label "$NODE_LABEL")\",environment=\"$(escape_label "$ENV_LABEL")\",gpu=\"$(escape_label "$index")\",uuid=\"$(escape_label "$uuid")\",name=\"$(escape_label "$name")\""
        echo "host_gpu_info{$labels} 1"
        echo "host_gpu_utilization_percent{$labels} $util"
        echo "host_gpu_memory_used_bytes{$labels} $((mem_used * 1024 * 1024))"
        echo "host_gpu_memory_total_bytes{$labels} $((mem_total * 1024 * 1024))"
        echo "host_gpu_temperature_celsius{$labels} $temp"
        echo "host_gpu_power_draw_watts{$labels} $power_draw"
        echo "host_gpu_power_limit_watts{$labels} $power_limit"
      done
    fi

    echo '# HELP host_directory_size_bytes Largest first-level directory sizes under configured roots.'
    echo '# TYPE host_directory_size_bytes gauge'
    echo '# HELP host_directory_scan_timestamp_seconds Last successful directory size scan timestamp.'
    echo '# TYPE host_directory_scan_timestamp_seconds gauge'
    for root in $ROOTS; do
      [ -d "$root" ] || continue
      {
        timeout "$DU_TIMEOUT" du -x -s -B1 "$root" 2>/dev/null || true
        find "$root" -mindepth 1 -maxdepth 1 -print0 2>/dev/null |
        while IFS= read -r -d '' path; do
          timeout "$DU_TIMEOUT" du -x -s -B1 "$path" 2>/dev/null || true
        done
      } | sort -nr | head -n "$TOP_N" | while IFS=$'\t' read -r size path; do
        [ -n "${size:-}" ] || continue
        labels="node=\"$(escape_label "$NODE_LABEL")\",environment=\"$(escape_label "$ENV_LABEL")\",root=\"$(escape_label "$root")\",path=\"$(escape_label "$path")\""
        echo "host_directory_size_bytes{$labels} $size"
      done
    done
    echo "host_directory_scan_timestamp_seconds{node=\"$(escape_label "$NODE_LABEL")\",environment=\"$(escape_label "$ENV_LABEL")\"} $(date +%s)"
  } > "$tmp"
  mv "$tmp" "$OUTPUT_FILE"
}

if [ "${1:-}" = "--once" ]; then
  write_metrics_once
  exit 0
fi

while true; do
  write_metrics_once || true
  sleep "$INTERVAL"
done
