#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .mock-setup-complete ]; then
  echo "verify: run ./setup.sh first" >&2
  exit 1
fi

node - <<'EOF'
const fs = require("fs");
let weights;
try {
  weights = JSON.parse(fs.readFileSync("solution/weights.json", "utf8"));
} catch (error) {
  console.error(`verify: solution/weights.json is invalid JSON: ${error.message}`);
  process.exit(1);
}
if (typeof weights.strategy !== "string" || weights.strategy.trim() === "") {
  console.error('verify: "strategy" must be a non-empty string');
  process.exit(1);
}
const keys = ["semanticWeight", "freshnessWeight", "diversityWeight"];
for (const key of keys) {
  const value = weights[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    console.error(`verify: "${key}" must be a finite number from 0 through 1`);
    process.exit(1);
  }
}
const total = keys.reduce((sum, key) => sum + weights[key], 0);
if (Math.abs(total - 1) > 1e-9) {
  console.error(`verify: ranking weights must sum to 1, got ${total}`);
  process.exit(1);
}
console.log("verify: ranking weights are valid");
EOF
