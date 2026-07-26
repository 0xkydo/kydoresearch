#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

touch .mock-setup-complete
echo "ranking-quality setup: local evaluator is ready"
