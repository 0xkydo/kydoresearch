#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .mock-setup-complete ]; then
  echo "verify: run ./setup.sh first" >&2
  exit 1
fi

node - <<'EOF'
const fs = require("fs");
let config;
try {
  config = JSON.parse(fs.readFileSync("solution/config.json", "utf8"));
} catch (error) {
  console.error(`verify: solution/config.json is invalid JSON: ${error.message}`);
  process.exit(1);
}
if (typeof config.strategy !== "string" || config.strategy.trim() === "") {
  console.error('verify: "strategy" must be a non-empty string');
  process.exit(1);
}
if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 64) {
  console.error('verify: "batchSize" must be an integer from 1 through 64');
  process.exit(1);
}
if (!Number.isInteger(config.cacheEntries) || config.cacheEntries < 0 || config.cacheEntries > 512) {
  console.error('verify: "cacheEntries" must be an integer from 0 through 512');
  process.exit(1);
}
if (typeof config.prefetch !== "boolean") {
  console.error('verify: "prefetch" must be boolean');
  process.exit(1);
}
console.log("verify: latency configuration is valid");
EOF
