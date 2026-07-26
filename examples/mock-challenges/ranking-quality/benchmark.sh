#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

./verify.sh

node - <<'EOF'
const fs = require("fs");
const weights = JSON.parse(fs.readFileSync("solution/weights.json", "utf8"));
const target = {
  semanticWeight: 0.55,
  freshnessWeight: 0.25,
  diversityWeight: 0.2,
};
const squaredError = Object.keys(target).reduce(
  (sum, key) => sum + (weights[key] - target[key]) ** 2,
  0,
);
const score = Number((1 - squaredError).toFixed(6));
const result = {
  score,
  metrics: {
    unit: "normalized-quality",
    strategy: weights.strategy,
    squaredError: Number(squaredError.toFixed(6)),
  },
};
fs.writeFileSync("score.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
EOF
