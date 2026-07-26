#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

touch .mock-setup-complete
echo "memory-packer setup: local evaluator is ready"
