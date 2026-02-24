#!/usr/bin/env bash
set -euo pipefail

# Pin benchmark process to CPU core 2 (avoids core 0 which handles interrupts)
if command -v taskset &>/dev/null; then
  exec taskset -c 2 bun run benchmarks/run.ts "$@"
else
  echo "Warning: taskset not available, running without CPU pinning"
  exec bun run benchmarks/run.ts "$@"
fi
