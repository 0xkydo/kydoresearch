#!/usr/bin/env bash
# Mock dependency install. Real challenges download toolchains/weights here.
set -euo pipefail
cd "$(dirname "$0")"
touch .autoresearch-setup-done
echo "mock-challenge: dependencies installed (marker written)"
