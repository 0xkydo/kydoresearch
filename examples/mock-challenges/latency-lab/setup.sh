#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

touch .mock-setup-complete
echo "latency-lab setup: local benchmark is ready"
